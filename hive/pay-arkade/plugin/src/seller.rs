//! The provider's side: quote, watch the escrow, admit within headroom, keep the latest receipt,
//! and claim before the deadline.
use crate::app::{App, allow, deny, is_hex32, reported_tokens, worst_case_tokens};
use crate::book::{DUST_SATS, Job, Status, now, price_msat};
use crate::protocol::{Message, Quote, Terms};
use anyhow::{Context, Result, bail};
use mesh_llm_plugin::PluginContext;
use mesh_llm_plugin::openai_exchange::OpenAiExchangeDecision;
use serde_json::{Value, json};
use std::sync::Arc;

/// Reservations for requests that never report back are dropped after this long.
const RESERVATION_TTL_SECS: u64 = 300;

impl App {
    pub fn terms(&self) -> Terms {
        Terms {
            v: 1,
            price_msat_per_mtok: self.cfg.price_msat_per_mtok,
            claim_key: self.pubkey.clone(),
            min_cap_sats: self.cfg.min_cap_sats,
            max_cap_sats: self.cfg.max_cap_sats,
            max_deadline_secs: self.cfg.max_deadline_secs,
        }
    }

    pub fn seller_exchange(&self, event: &Value) -> OpenAiExchangeDecision {
        let phase = event["phase"].as_str().unwrap_or_default();
        let exchange = event["exchange_id"].as_str().unwrap_or_default().to_string();
        // Only requests from mesh peers are sold; the node's own local traffic is not.
        let Some(peer) = event["requested_by_node_id"].as_str() else { return Default::default() };
        // A request that names no model is treated as gated: when in doubt, it is not free.
        let model = event["model"].as_str();
        if model.is_some() && !self.pays_for(model) {
            return Default::default();
        }
        let mut book = self.book.lock().unwrap();
        match phase {
            "request_received" => {
                // A stream reports token usage only when the client asks for it; without usage the
                // answer would be served and never paid, so such a stream is refused up front.
                let body = &event["body"];
                if body["stream"] == json!(true) && body["stream_options"]["include_usage"] != json!(true) {
                    return deny("streamed requests must set stream_options.include_usage so the answer can be paid");
                }
                let worst = price_msat(worst_case_tokens(event, self.cfg.default_max_tokens), self.cfg.price_msat_per_mtok);
                let Some(job) = book.live_with(peer).filter(|j| j.status == Status::Open) else {
                    return deny("no open job: send an offer on pay.arkade.v1");
                };
                let quote = job.quote.as_ref().expect("an open job has a quote");
                if model.is_some_and(|m| m != quote.model) {
                    return deny("the open job is for another model");
                }
                if now() + self.cfg.close_margin_secs >= quote.deadline {
                    return deny("the job is closing");
                }
                let cutoff = now().saturating_sub(RESERVATION_TTL_SECS);
                job.reserved.retain(|_, (_, at)| *at >= cutoff);
                if job.usage_msat + job.reserved_msat() + worst > job.cap_msat() {
                    return deny("the job's cap is reached");
                }
                if job.usage_sats().saturating_sub(job.receipt_sats) > self.cfg.max_unreceipted_sats {
                    return deny("waiting for a receipt");
                }
                job.reserved.insert(exchange.clone(), (worst, now()));
                self.log(json!({"event": "admitted", "job_id": job.job_id, "exchange_id": exchange, "reserved_msat": worst,
                    "has_body": !event["body"].is_null()}));
                self.save(&book);
                allow()
            }
            "exchange_finished" => {
                let Some(job) = book.live_with(peer).filter(|j| j.status == Status::Open) else {
                    return Default::default();
                };
                let released = job.reserved.remove(&exchange).is_some();
                let Some(tokens) = reported_tokens(event) else {
                    self.save(&book);
                    return Default::default();
                };
                let price = job.quote.as_ref().map_or(0, |q| q.price_msat_per_mtok);
                job.usage_msat = (job.usage_msat + price_msat(tokens, price)).min(job.cap_msat());
                let (job_id, usage_msat) = (job.job_id.clone(), job.usage_msat);
                self.save(&book);
                drop(book);
                self.log(json!({"event": "billed", "job_id": job_id, "exchange_id": exchange, "tokens": tokens,
                    "usage_msat": usage_msat, "reservation_released": released}));
                Default::default()
            }
            _ => Default::default(),
        }
    }

    pub async fn seller_message(self: &Arc<Self>, peer: &str, message: Message, ctx: &mut PluginContext<'_>) -> Result<()> {
        match message {
            Message::Offer { job_id, model, cap_sats, deadline, agent_pk, treasury_program } => {
                let reply = match self.quote(peer, job_id.clone(), model, cap_sats, deadline, agent_pk, treasury_program).await {
                    Ok(reply) => reply,
                    Err(e) => Message::Decline { job_id, reason: e.to_string() },
                };
                self.send(ctx, peer, &reply).await
            }
            Message::Receipt { job_id, amount_sats, sig } => self.accept_receipt(peer, &job_id, amount_sats, &sig).await,
            Message::RenewalAnswer { job_id, answer } => {
                let job = self.book.lock().unwrap().jobs.get(&job_id).filter(|j| j.peer == peer && j.status == Status::Quoted).cloned();
                let Some(job) = job else { return Ok(()) };
                let quote = job.quote.clone().expect("quoted");
                match self.worker.call("renewal_finish", json!({"params": quote.params(), "answer": answer})).await {
                    Ok(done) => {
                        if let Some(j) = self.book.lock().unwrap().jobs.get_mut(&job_id) {
                            j.renewal_registered = true;
                        }
                        self.log(json!({"event": "renewal_registered", "job_id": job_id, "valid_at": done["validAt"]}));
                        let status = self.worker.call("escrow_status", json!({"params": quote.params()})).await?;
                        let locked = status["fundingSats"].as_u64().unwrap_or(0);
                        self.set_status(&job_id, Status::Open, None, None);
                        self.log(json!({"event": "job_open", "job_id": job_id, "locked_sats": locked}));
                        self.send(ctx, peer, &Message::Opened { job_id, locked_sats: locked }).await
                    }
                    Err(e) => {
                        // Asked again on the next funding check.
                        self.log(json!({"event": "error", "job_id": job_id, "error": format!("renewal: {e}")}));
                        Ok(())
                    }
                }
            }
            Message::Close { job_id } => {
                let job = self.book.lock().unwrap().jobs.get(&job_id).filter(|j| j.peer == peer).cloned();
                match job {
                    Some(job) if job.status == Status::Open => self.close(job, ctx).await,
                    _ => Ok(()),
                }
            }
            _ => Ok(()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn quote(
        &self,
        peer: &str,
        job_id: String,
        model: String,
        cap_sats: u64,
        deadline: u64,
        agent_pk: String,
        treasury_program: String,
    ) -> Result<Message> {
        if !self.allows(peer) {
            bail!("this provider does not take jobs from this node");
        }
        if !self.cfg.models.contains(&model) {
            bail!("model not sold here");
        }
        if !(is_hex32(&job_id) && is_hex32(&agent_pk) && is_hex32(&treasury_program)) {
            bail!("job id, agent key and treasury program must be 32 bytes of hex");
        }
        if cap_sats < self.cfg.min_cap_sats || cap_sats > self.cfg.max_cap_sats {
            bail!("cap must be between {} and {} sats", self.cfg.min_cap_sats, self.cfg.max_cap_sats);
        }
        let t = now();
        if deadline > t + self.cfg.max_deadline_secs || deadline < t + 2 * self.cfg.close_margin_secs {
            bail!("deadline out of range");
        }
        {
            let mut book = self.book.lock().unwrap();
            if book.jobs.contains_key(&job_id) {
                bail!("job id already used");
            }
            if book.live_with(peer).is_some() {
                bail!("a job with this buyer is already live");
            }
        }
        let mut quote = Quote {
            job_id: job_id.clone(),
            model,
            price_msat_per_mtok: self.cfg.price_msat_per_mtok,
            cap_sats,
            deadline,
            agent_pk,
            provider_pk: self.pubkey.clone(),
            treasury_program,
            escrow_address: String::new(),
            delegate_pk: None,
        };
        if self.cfg.delegate.is_some() {
            // The escrow names the delegate service that will renew it; its key is part of the address.
            let info = self.worker.call("delegate_info", json!({})).await?;
            quote.delegate_pk = Some(info["xonly"].as_str().context("delegate service gave no key")?.to_string());
        }
        let escrow = self.worker.call("escrow", json!({"params": quote.params()})).await?;
        quote.escrow_address = escrow["address"].as_str().unwrap_or_default().to_string();
        let sig = self.worker.call("sign_quote", json!({"quote": quote})).await?;
        let sig = sig["sig"].as_str().unwrap_or_default().to_string();
        let mut job = Job::new(job_id.clone(), peer.to_string(), Status::Quoted);
        job.quote = Some(quote.clone());
        {
            let mut book = self.book.lock().unwrap();
            if book.jobs.contains_key(&job_id) || book.live_with(peer).is_some() {
                bail!("a job with this buyer is already live");
            }
            book.jobs.insert(job_id, job);
            self.save(&book);
        }
        Ok(Message::Quote { quote, sig })
    }

    async fn accept_receipt(&self, peer: &str, job_id: &str, amount_sats: u64, sig: &str) -> Result<()> {
        let Some(job) = self.book.lock().unwrap().jobs.get(job_id).filter(|j| j.peer == peer).cloned() else {
            bail!("receipt for an unknown job");
        };
        let quote = job.quote.as_ref().expect("a quoted job has a quote");
        if amount_sats > quote.cap_sats {
            bail!("receipt exceeds the cap");
        }
        if amount_sats <= job.receipt_sats {
            return Ok(()); // stale or repeated
        }
        let check = self
            .worker
            .call("verify_receipt", json!({"agentPk": quote.agent_pk, "jobId": job_id, "amountSats": amount_sats, "sig": sig}))
            .await?;
        if check["valid"] != json!(true) {
            bail!("receipt signature does not verify");
        }
        let mut book = self.book.lock().unwrap();
        let Some(job) = book.jobs.get_mut(job_id) else { return Ok(()) };
        if amount_sats > job.receipt_sats {
            job.receipt_sats = amount_sats;
            job.receipt_sig = Some(sig.to_string());
            let usage_sats = job.usage_sats();
            self.save(&book);
            drop(book);
            self.log(json!({"event": "receipt_accepted", "job_id": job_id, "amount_sats": amount_sats, "usage_sats": usage_sats}));
        }
        Ok(())
    }

    pub async fn seller_tick(self: &Arc<Self>, ctx: &mut PluginContext<'_>) {
        let jobs: Vec<Job> = self
            .book
            .lock()
            .unwrap()
            .jobs
            .values()
            .filter(|j| matches!(j.status, Status::Quoted | Status::Open))
            .cloned()
            .collect();
        for job in jobs {
            let result = match job.status {
                Status::Quoted => self.watch_funding(job, ctx).await,
                Status::Open if now() + self.cfg.close_margin_secs >= job.deadline() => self.close(job, ctx).await,
                _ => Ok(()),
            };
            if let Err(e) = result {
                self.log(json!({"event": "error", "error": e.to_string()}));
            }
        }
    }

    async fn watch_funding(&self, job: Job, ctx: &mut PluginContext<'_>) -> Result<()> {
        let quote = job.quote.clone().expect("quoted");
        if now() + self.cfg.close_margin_secs >= quote.deadline {
            self.set_status(&job.job_id, Status::Expired, Some("never funded".into()), None);
            return Ok(());
        }
        let status = self.worker.call("escrow_status", json!({"params": quote.params()})).await?;
        // The job's funding is the escrow's largest coin: dust anyone sends to the public address
        // beside it changes nothing.
        let (open, locked) = (status["open"].as_u64().unwrap_or(0), status["fundingSats"].as_u64().unwrap_or(0));
        if open == 0 {
            return Ok(());
        }
        if locked == quote.cap_sats {
            // A coin swept before the deadline cannot be claimed or returned: refuse it while it can
            // still go back. Regtest states expiry in blocks, which this check does not read.
            if self.cfg.delegate.is_some() && quote.delegate_pk.is_some() {
                // The delegate service renews the coin before its batch expires, so its expiry does not
                // matter; the job opens once the agent has signed the renewal with us and it is submitted.
                if job.renewal_registered {
                    return Ok(());
                }
                if now() < job.renewal_requested_at + 120 {
                    return Ok(());
                }
                let mut ask = json!({"params": quote.params()});
                if let Some(after) = self.cfg.renew_after_secs {
                    ask["renewAt"] = json!(now() + after);
                }
                let request = self.worker.call("renewal_prepare", ask).await?;
                if let Some(j) = self.book.lock().unwrap().jobs.get_mut(&job.job_id) {
                    j.renewal_requested_at = now();
                }
                self.log(json!({"event": "renewal_requested", "job_id": job.job_id, "valid_at": request["message"]["valid_at"]}));
                return self.send(ctx, &job.peer, &Message::RenewalRequest { job_id: job.job_id.clone(), request }).await;
            }
            let short = if self.cfg.executor.is_some() {
                // The executor renews the coin before its batch expires, so its expiry does not
                // matter; the renewal must be registered and live.
                let renewal = self.worker.call("renewal_status", json!({"params": quote.params()})).await?;
                let live = renewal["registered"] == json!(true) && renewal["status"].as_str().is_some_and(|s| s.eq_ignore_ascii_case("active"));
                (!live).then(|| format!("the escrow's renewal is not registered with the executor ({})", renewal["status"]))
            } else {
                let needed = quote.deadline + self.cfg.min_coin_life_secs;
                match status["expiresAt"].as_u64() {
                    Some(expires) => (expires < needed).then(|| format!("escrow coin expires at {expires}, before {needed}")),
                    None if self.cfg.network != "regtest" => Some("escrow coin states no expiry time".to_string()),
                    None => None,
                }
            };
            if let Some(note) = short {
                self.set_status(&job.job_id, Status::Failed, Some(note.clone()), None);
                return self.send(ctx, &job.peer, &Message::Decline { job_id: job.job_id, reason: note }).await;
            }
            self.set_status(&job.job_id, Status::Open, None, None);
            self.log(json!({"event": "job_open", "job_id": job.job_id, "locked_sats": locked}));
            self.send(ctx, &job.peer, &Message::Opened { job_id: job.job_id, locked_sats: locked }).await
        } else {
            // A coin of exactly the cap is the only funding the claim path can spend in full. Anything
            // else at the address may be someone's dust: keep waiting for the funding until the deadline.
            let _ = open;
            Ok(())
        }
    }

    /// Claim with the latest receipt. Below dust there is nothing claimable; the job is left to expire.
    async fn close(self: &Arc<Self>, job: Job, ctx: &mut PluginContext<'_>) -> Result<()> {
        let Some(_guard) = self.guard(&job.job_id) else { return Ok(()) };
        let quote = job.quote.clone().expect("open");
        let (Some(sig), true) = (job.receipt_sig.clone(), job.receipt_sats >= DUST_SATS) else {
            self.set_status(&job.job_id, Status::Expired, Some(format!("receipted {} sats, below dust; left to expire", job.receipt_sats)), None);
            let closed = Message::Closed { job_id: job.job_id.clone(), txid: None, paid_sats: 0, returned_sats: 0 };
            return self.send(ctx, &job.peer, &closed).await;
        };
        let mut request = json!({"params": quote.params(), "amountSats": job.receipt_sats, "agentSig": sig});
        if let Some(script) = &self.cfg.payout_pk_script {
            request["payoutPkScript"] = json!(script);
        }
        match self.worker.call("claim", request).await {
            Ok(result) => {
                let txid = result["txid"].as_str().map(str::to_string);
                let paid = result["paidSats"].as_u64().unwrap_or(0);
                let returned = result["returnedSats"].as_u64().unwrap_or(0);
                self.set_status(&job.job_id, Status::Closed, None, txid.clone());
                self.log(json!({"event": "claimed", "job_id": job.job_id, "txid": txid, "paid_sats": paid,
                    "returned_sats": returned, "usage_sats": job.usage_sats()}));
                let closed = Message::Closed { job_id: job.job_id.clone(), txid, paid_sats: paid, returned_sats: returned };
                self.send(ctx, &job.peer, &closed).await
            }
            Err(e) if now() >= quote.deadline => {
                self.set_status(&job.job_id, Status::Failed, Some(format!("claim failed past the deadline: {e}")), None);
                Err(e)
            }
            Err(e) => Err(e), // retried on the next tick
        }
    }

    pub fn set_status(&self, job_id: &str, status: Status, note: Option<String>, txid: Option<String>) {
        let mut book = self.book.lock().unwrap();
        if let Some(job) = book.jobs.get_mut(job_id) {
            job.status = status;
            if note.is_some() {
                job.note = note;
            }
            if txid.is_some() {
                job.txid = txid;
            }
            self.save(&book);
        }
    }
}
