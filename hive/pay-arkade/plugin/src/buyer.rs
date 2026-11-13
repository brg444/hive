//! The hive agent's side: offer, check the quote, queue the job for funding, sign a receipt
//! after each answer, and return whatever is left unclaimed after the deadline.
use crate::app::{App, allow, deny, random_hex32, reported_tokens};
use crate::book::{Job, Status, now, price_msat};
use crate::protocol::{Message, Quote};
use anyhow::{Context, Result, bail};
use mesh_llm_plugin::PluginContext;
use mesh_llm_plugin::openai_exchange::OpenAiExchangeDecision;
use serde_json::{Value, json};
use std::sync::Arc;

/// An offer with no quote after this long is given up.
const OFFER_TIMEOUT_SECS: u64 = 60;

impl App {
    /// Returns the decision, and the provider to open a job with when there is none yet.
    pub fn buyer_exchange(&self, event: &Value) -> (OpenAiExchangeDecision, Option<(String, String)>) {
        let phase = event["phase"].as_str().unwrap_or_default();
        let exchange = event["exchange_id"].as_str().unwrap_or_default().to_string();
        match phase {
            "backend_selected" => {
                let Some(target) = event["target_peer_id"].as_str() else { return (Default::default(), None) };
                let model = event["model"].as_str();
                if !self.pays_for(model) {
                    return (Default::default(), None);
                }
                if !self.allows(target) {
                    return (deny("this provider is not on the hive's list"), None);
                }
                let mut book = self.book.lock().unwrap();
                let Some(job) = book.live_with(target) else {
                    // No job with this provider yet: deny this attempt, which sends the host on to
                    // the next provider, and open one for next time.
                    return (deny("opening a job with this provider"), Some((target.to_string(), model.unwrap().to_string())));
                };
                if job.status != Status::Open {
                    return (deny("the job with this provider is waiting for funding"), None);
                }
                // The seller reserves each request's worst case against the escrow; the buyer only
                // routes to a provider whose job is open and not yet spent.
                let quote = job.quote.as_ref().expect("open");
                if now() + self.cfg.close_margin_secs >= quote.deadline || job.usage_msat >= job.cap_msat() {
                    return (deny("the job with this provider is spent or closing"), None);
                }
                drop(book);
                self.exchanges.lock().unwrap().insert(exchange, target.to_string());
                (allow(), None)
            }
            _ => (Default::default(), None),
        }
    }

    /// After an answer: add its cost and send a receipt for the new cumulative total.
    pub async fn buyer_finished(&self, event: &Value, ctx: &mut PluginContext<'_>) -> Result<()> {
        let exchange = event["exchange_id"].as_str().unwrap_or_default();
        let Some(peer) = self.exchanges.lock().unwrap().remove(exchange) else { return Ok(()) };
        let Some(tokens) = reported_tokens(event) else { return Ok(()) };
        let (job_id, amount) = {
            let mut book = self.book.lock().unwrap();
            let Some(job) = book.live_with(&peer).filter(|j| j.status == Status::Open) else { return Ok(()) };
            let quote = job.quote.clone().expect("open");
            job.usage_msat = (job.usage_msat + price_msat(tokens, quote.price_msat_per_mtok)).min(job.cap_msat());
            let amount = job.usage_sats();
            self.save(&book);
            (quote.job_id, amount)
        };
        if amount == 0 {
            return Ok(());
        }
        let signed = self.worker.call("sign_receipt", json!({"jobId": job_id, "amountSats": amount})).await?;
        let sig = signed["sig"].as_str().context("worker returned no signature")?.to_string();
        {
            let mut book = self.book.lock().unwrap();
            if let Some(job) = book.jobs.get_mut(&job_id)
                && amount > job.receipt_sats
            {
                job.receipt_sats = amount;
                job.receipt_sig = Some(sig.clone());
                self.save(&book);
            }
        }
        self.log(json!({"event": "receipt_signed", "job_id": job_id, "exchange_id": exchange, "tokens": tokens, "amount_sats": amount}));
        self.send(ctx, &peer, &Message::Receipt { job_id, amount_sats: amount, sig }).await
    }

    pub async fn offer(self: &Arc<Self>, peer: String, model: String, ctx: &mut PluginContext<'_>) -> Result<()> {
        let Some(_guard) = self.guard(&format!("offer:{peer}")) else { return Ok(()) };
        let treasury_program = self.cfg.treasury_program.clone().context("--treasury-program is required for a buyer")?;
        let job_id = random_hex32();
        let deadline = now() + self.cfg.period_secs;
        // Until the quote arrives, the job holds what was offered, to check the quote against.
        let expected = Quote {
            job_id: job_id.clone(),
            model: model.clone(),
            price_msat_per_mtok: 0,
            cap_sats: self.cfg.cap_sats,
            deadline,
            agent_pk: self.pubkey.clone(),
            provider_pk: String::new(),
            treasury_program: treasury_program.clone(),
            escrow_address: String::new(),
            delegate_pk: None,
        };
        {
            let mut book = self.book.lock().unwrap();
            if book.live_with(&peer).is_some() {
                return Ok(());
            }
            // Never commit more than the cap across every job not yet settled.
            let committed: u64 = book
                .jobs
                .values()
                .filter(|j| matches!(j.status, Status::Offered | Status::Quoted | Status::Open))
                .map(|j| j.quote.as_ref().map_or(0, |q| q.cap_sats))
                .sum();
            if committed + self.cfg.cap_sats > self.cfg.max_open_sats {
                drop(book);
                self.log(json!({"event": "offer_skipped", "peer": peer, "committed_sats": committed,
                    "max_open_sats": self.cfg.max_open_sats}));
                return Ok(());
            }
            let mut job = Job::new(job_id.clone(), peer.clone(), Status::Offered);
            job.quote = Some(expected);
            book.jobs.insert(job_id.clone(), job);
            self.save(&book);
        }
        let offer = Message::Offer { job_id, model, cap_sats: self.cfg.cap_sats, deadline, agent_pk: self.pubkey.clone(), treasury_program };
        self.send(ctx, &peer, &offer).await
    }

    pub async fn buyer_message(self: &Arc<Self>, peer: &str, message: Message, ctx: &mut PluginContext<'_>) -> Result<()> {
        match message {
            Message::Quote { quote, sig } => {
                let job_id = quote.job_id.clone();
                if let Err(e) = self.check_quote(peer, quote, &sig).await {
                    self.set_status(&job_id, Status::Failed, Some(format!("quote refused: {e}")), None);
                    return Err(e);
                }
                Ok(())
            }
            Message::Decline { job_id, reason } => {
                self.set_status_if(&job_id, peer, &[Status::Offered, Status::Quoted], Status::Failed, Some(format!("declined: {reason}")));
                Ok(())
            }
            Message::Opened { job_id, .. } => self.confirm_funded(&job_id).await,
            Message::RenewalRequest { job_id, request } => {
                // Sign the escrow's renewal only for this provider's own funded job; the worker checks
                // that it renews this escrow into itself through the job's delegate and nothing else.
                let quote = {
                    let book = self.book.lock().unwrap();
                    book.jobs.get(&job_id).filter(|j| j.peer == peer && matches!(j.status, Status::Quoted | Status::Open)).and_then(|j| j.quote.clone())
                };
                let Some(quote) = quote else { return Ok(()) };
                let answer = self.worker.call("renewal_cosign", json!({"params": quote.params(), "request": request})).await?;
                self.log(json!({"event": "renewal_signed", "job_id": job_id}));
                self.send(ctx, peer, &Message::RenewalAnswer { job_id, answer }).await
            }
            Message::Closed { job_id, txid, paid_sats, returned_sats } => {
                // A claim moves the coin, which the expiry pass will see; a close with no claim
                // leaves the escrow for this side to return after the deadline.
                if let Some(txid) = &txid {
                    self.set_status_if(&job_id, peer, &[Status::Open], Status::Closed, None);
                    if let Some(job) = self.book.lock().unwrap().jobs.get_mut(&job_id).filter(|j| j.status == Status::Closed) {
                        job.txid = Some(txid.clone());
                    }
                }
                self.log(json!({"event": "job_closed", "job_id": job_id, "txid": txid, "paid_sats": paid_sats, "returned_sats": returned_sats}));
                Ok(())
            }
            _ => Ok(()),
        }
    }

    async fn check_quote(&self, peer: &str, quote: Quote, sig: &str) -> Result<()> {
        let expected = {
            let book = self.book.lock().unwrap();
            let job = book.jobs.get(&quote.job_id).filter(|j| j.peer == peer && j.status == Status::Offered);
            job.and_then(|j| j.quote.clone()).context("quote for no open offer")?
        };
        if (quote.model.as_str(), quote.cap_sats, quote.deadline, quote.agent_pk.as_str(), quote.treasury_program.as_str())
            != (expected.model.as_str(), expected.cap_sats, expected.deadline, expected.agent_pk.as_str(), expected.treasury_program.as_str())
        {
            bail!("quote does not match the offer");
        }
        if quote.price_msat_per_mtok > self.cfg.max_price_msat_per_mtok {
            bail!("price {} above the limit {}", quote.price_msat_per_mtok, self.cfg.max_price_msat_per_mtok);
        }
        let valid = self.worker.call("verify_quote", json!({"providerPk": quote.provider_pk, "quote": quote, "sig": sig})).await?;
        if valid["valid"] != json!(true) {
            bail!("quote signature does not verify");
        }
        // A renewal by a delegate service is only as good as the service: it must be the one this hive uses.
        if let Some(delegate_pk) = &quote.delegate_pk {
            if self.cfg.delegate.is_none() {
                bail!("the provider renews through a delegate service this hive has not chosen");
            }
            let info = self.worker.call("delegate_info", json!({})).await?;
            if info["xonly"].as_str() != Some(delegate_pk.as_str()) {
                bail!("the provider names another delegate service");
            }
        }
        // Never fund an address on the provider's word: derive it from the terms.
        let escrow = self.worker.call("escrow", json!({"params": quote.params()})).await?;
        if escrow["address"].as_str() != Some(quote.escrow_address.as_str()) {
            bail!("escrow address does not match the terms");
        }
        let mut request = json!({"event": "fund", "job_id": quote.job_id, "address": quote.escrow_address, "cap_sats": quote.cap_sats,
            "deadline": quote.deadline, "model": quote.model, "price_msat_per_mtok": quote.price_msat_per_mtok,
            "provider_peer": peer, "provider_pk": quote.provider_pk,
            // Every term the escrow is built from, so each keeper can rebuild the address before signing.
            "params": quote.params()});
        if quote.delegate_pk.is_some() {
            // The delegate service renews the escrow once it is funded, so any coin will do.
            request["renewal"] = json!({"delegate": self.cfg.delegate, "delegate_pk": quote.delegate_pk});
        } else if let Some(executor) = &self.cfg.executor {
            // The executor renews the escrow until the job is settled, so any coin will do. The
            // renewal is registered before keepers are asked to fund, and outlasts the return.
            let setup = self.worker.call("renewal_setup", json!({})).await?;
            let template = setup["templateId"].as_str().context("executor gave no template id")?;
            let until = quote.deadline + self.cfg.expire_grace_secs + 3_600;
            let delegation = self
                .worker
                .call("renewal_register", json!({"params": quote.params(), "templateId": template, "expiresAt": until}))
                .await
                .context("registering the escrow's renewal")?;
            request["renewal"] = json!({"executor": executor, "delegation": delegation["id"], "until": until});
            self.log(json!({"event": "renewal_registered", "job_id": quote.job_id, "delegation": delegation["id"], "until": until}));
        } else {
            // Without renewal, keepers must fund from a coin that outlives the job, or the provider refuses it.
            request["min_coin_expiry"] = json!(quote.deadline + self.cfg.min_coin_life_secs);
        }
        {
            let mut book = self.book.lock().unwrap();
            let Some(job) = book.jobs.get_mut(&quote.job_id) else { return Ok(()) };
            job.quote = Some(quote);
            job.status = Status::Quoted;
            self.save(&book);
        }
        if let Some(queue) = &self.cfg.funding_queue {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(queue)?;
            writeln!(f, "{request}")?;
        }
        self.log(json!({"event": "funding_requested", "request": request}));
        Ok(())
    }

    async fn confirm_funded(&self, job_id: &str) -> Result<()> {
        let Some(quote) = self.book.lock().unwrap().jobs.get(job_id).filter(|j| j.status == Status::Quoted).and_then(|j| j.quote.clone())
        else {
            return Ok(());
        };
        // Too late to serve: the provider has stopped admitting. The expiry pass returns it.
        if now() + self.cfg.close_margin_secs >= quote.deadline {
            return Ok(());
        }
        let status = self.worker.call("escrow_status", json!({"params": quote.params()})).await?;
        if status["open"] == json!(1) && status["lockedSats"].as_u64() == Some(quote.cap_sats) {
            self.set_status(job_id, Status::Open, None, None);
            self.log(json!({"event": "job_open", "job_id": job_id, "locked_sats": quote.cap_sats}));
        }
        Ok(())
    }

    pub async fn buyer_tick(self: &Arc<Self>) {
        let jobs: Vec<Job> = self.book.lock().unwrap().jobs.values().cloned().collect();
        let t = now();
        for job in jobs {
            let deadline = job.deadline();
            let result = match job.status {
                Status::Offered if t > job.created_at + OFFER_TIMEOUT_SECS => {
                    self.set_status(&job.job_id, Status::Failed, Some("no quote".into()), None);
                    Ok(())
                }
                // Funding that arrives after the provider gave up still sits in the escrow:
                // once the deadline passes, return whatever is there.
                Status::Quoted if t > deadline + self.cfg.expire_grace_secs => self.return_unclaimed(&job).await,
                Status::Quoted if t > deadline => Ok(()),
                Status::Quoted => self.confirm_funded(&job.job_id).await,
                Status::Open if t > deadline + self.cfg.expire_grace_secs => self.return_unclaimed(&job).await,
                _ => Ok(()),
            };
            if let Err(e) = result {
                self.log(json!({"event": "error", "job_id": job.job_id, "error": e.to_string()}));
            }
        }
    }

    /// Past the deadline and grace: if the coin is still there, send it back to the treasury.
    async fn return_unclaimed(self: &Arc<Self>, job: &Job) -> Result<()> {
        let Some(_guard) = self.guard(&job.job_id) else { return Ok(()) };
        let quote = job.quote.clone().expect("open");
        let status = self.worker.call("escrow_status", json!({"params": quote.params()})).await?;
        if status["open"].as_u64().unwrap_or(0) == 0 {
            let (next, note) = match (job.status, status["coins"].as_array().is_some_and(|c| !c.is_empty())) {
                (Status::Quoted, false) => (Status::Expired, "never funded"),
                (_, true) => (Status::Closed, "escrow already spent"),
                (_, false) => (Status::Expired, "escrow empty"),
            };
            self.set_status(&job.job_id, next, Some(note.into()), None);
            return Ok(());
        }
        let result = self.worker.call("expire", json!({"params": quote.params()})).await?;
        let txid = result["txid"].as_str().map(str::to_string);
        self.set_status(&job.job_id, Status::Expired, Some("returned to the treasury".into()), txid.clone());
        self.log(json!({"event": "expired", "job_id": job.job_id, "txid": txid, "returned_sats": result["returnedSats"],
            "receipt_sats": job.receipt_sats}));
        Ok(())
    }

    fn set_status_if(&self, job_id: &str, peer: &str, from: &[Status], to: Status, note: Option<String>) {
        let mut book = self.book.lock().unwrap();
        if let Some(job) = book.jobs.get_mut(job_id).filter(|j| j.peer == peer && from.contains(&j.status)) {
            job.status = to;
            if note.is_some() {
                job.note = note;
            }
            self.save(&book);
        }
    }
}
