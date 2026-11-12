//! State and plumbing shared by both roles: configuration, the worker, the job book, the
//! event log, and sending on the channel.
use crate::book::Book;
use crate::protocol::{CHANNEL, Message};
use crate::worker::Worker;
use anyhow::Result;
use mesh_llm_plugin::PluginContext;
use mesh_llm_plugin::openai_exchange::{OpenAiAdmissionDecision, OpenAiExchangeDecision};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Seller,
    Buyer,
}

/// The member role runs without a wallet or a job book; see `member.rs`.
pub const MEMBER_ROLE: &str = "member";

#[derive(Debug, Clone)]
pub struct Config {
    pub role: Role,
    /// Seller: the models it gates. Buyer: the models it pays for; others pass through.
    pub models: Vec<String>,
    pub log: Option<PathBuf>,
    /// Requests whose body names no output limit are priced as if they asked for this many.
    pub default_max_tokens: u64,
    pub state_dir: PathBuf,
    /// Buyer: members allowed to run requests on the hive's budget, written by the coordinator.
    pub members_file: Option<PathBuf>,
    /// The Bitcoin network the worker runs on: regtest, signet, mutinynet or bitcoin.
    pub network: String,
    /// The mesh peers this node deals with: buyers a seller quotes, providers a buyer pays.
    /// Empty means anyone, which a mainnet node refuses unless told `--allow-any-peer`.
    pub allow_peers: Vec<String>,

    // Seller
    pub price_msat_per_mtok: u64,
    pub min_cap_sats: u64,
    pub max_cap_sats: u64,
    pub max_deadline_secs: u64,
    /// The seller stops admitting and claims this long before a job's deadline.
    pub close_margin_secs: u64,
    /// How far usage may run ahead of the latest receipt before requests wait.
    pub max_unreceipted_sats: u64,
    /// Where claims pay; the claim key's own address when unset.
    pub payout_pk_script: Option<String>,
    /// An escrow coin must outlive the job's deadline by this long, or the job is not opened:
    /// Arkade sweeps a coin's batch when it expires, and an escrow cannot be returned early.
    pub min_coin_life_secs: u64,
    /// An executor (arkade-os/executor) that renews escrow coins before their batches expire. With
    /// one, the buyer registers each escrow's renewal and the seller requires it instead of a long-lived coin.
    pub executor: Option<String>,
    /// A delegate service (the Arkade wallet's, delegate.arkade.money on mainnet) that renews escrow
    /// coins from a renewal the agent and the provider presign together.
    pub delegate: Option<String>,
    /// Testing: have the delegate service renew each escrow this many seconds after funding instead of
    /// just before its batch expires, so a renewal can be watched on mainnet; it costs the early fee.
    pub renew_after_secs: Option<u64>,

    // Buyer
    pub cap_sats: u64,
    pub period_secs: u64,
    pub max_price_msat_per_mtok: u64,
    pub treasury_program: Option<String>,
    /// Funding requests for the keepers, one JSON line per job.
    pub funding_queue: Option<PathBuf>,
    /// How long after a deadline the buyer waits before returning an escrow itself.
    pub expire_grace_secs: u64,
    /// The most the agent may have committed at once, across every job not yet settled.
    pub max_open_sats: u64,
}

pub struct App {
    pub cfg: Config,
    pub worker: Arc<Worker>,
    pub book: Mutex<Book>,
    /// This node's key in the worker: the claim key on a seller, the receipt key on a buyer.
    pub pubkey: String,
    /// Buyer: which provider each in-flight exchange went to.
    pub exchanges: Mutex<HashMap<String, String>>,
    /// Peers or jobs with work in progress that must not start twice (an offer, a claim).
    pub busy: Mutex<HashSet<String>>,
}

impl App {
    pub fn log(&self, event: Value) {
        let Some(path) = &self.cfg.log else { return };
        use std::io::Write;
        let mut event = event;
        event["at"] = json!(crate::book::now());
        event["role"] = json!(if self.cfg.role == Role::Seller { "seller" } else { "buyer" });
        // One write per line, under a lock: concurrent hooks must never interleave a line.
        static LOG: Mutex<()> = Mutex::new(());
        let line = format!("{event}\n");
        let _held = LOG.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = f.write_all(line.as_bytes());
        }
    }

    pub async fn send(&self, ctx: &mut PluginContext<'_>, peer: &str, message: &Message) -> Result<()> {
        ctx.send_json_channel(CHANNEL, peer, message.label(), message).await?;
        self.log(json!({"event": "sent", "to": peer, "message": message}));
        Ok(())
    }

    pub fn save(&self, book: &Book) {
        if let Err(e) = book.save() {
            self.log(json!({"event": "error", "error": format!("saving the job book: {e}")}));
        }
    }

    /// Claim a guard on `key`; `None` when someone already holds it.
    pub fn guard(self: &Arc<Self>, key: &str) -> Option<Guard> {
        self.busy.lock().unwrap().insert(key.to_string()).then(|| Guard { app: self.clone(), key: key.to_string() })
    }

    pub fn allows(&self, peer: &str) -> bool {
        self.cfg.allow_peers.is_empty() || self.cfg.allow_peers.iter().any(|p| p.eq_ignore_ascii_case(peer))
    }

    pub fn pays_for(&self, model: Option<&str>) -> bool {
        model.is_some_and(|m| self.cfg.models.iter().any(|x| x == m))
    }
}

pub struct Guard {
    app: Arc<App>,
    key: String,
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.app.busy.lock().unwrap().remove(&self.key);
    }
}

pub fn deny(reason: impl Into<String>) -> OpenAiExchangeDecision {
    OpenAiExchangeDecision {
        decision: OpenAiAdmissionDecision::Deny,
        status: Some(402),
        reason: Some(reason.into()),
        annotations: Vec::new(),
        response_headers: Vec::new(),
    }
}

pub fn allow() -> OpenAiExchangeDecision {
    OpenAiExchangeDecision {
        decision: OpenAiAdmissionDecision::Allow,
        status: None,
        reason: None,
        annotations: Vec::new(),
        response_headers: Vec::new(),
    }
}

/// Input plus output tokens from the backend's reported usage.
pub fn reported_tokens(event: &Value) -> Option<u64> {
    let usage = &event["usage"];
    Some(usage["prompt_tokens"].as_u64()? + usage["completion_tokens"].as_u64()?)
}

/// An upper estimate of a request's tokens: its output limit plus its body at three bytes a token.
pub fn worst_case_tokens(event: &Value, default_max_tokens: u64) -> u64 {
    let body = &event["body"];
    let output = ["max_tokens", "max_completion_tokens", "max_output_tokens"]
        .iter()
        .find_map(|k| body[k].as_u64())
        .unwrap_or(default_max_tokens);
    let input = if body.is_null() { default_max_tokens } else { body.to_string().len() as u64 / 3 + 1 };
    input + output
}

pub fn random_hex32() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system randomness");
    hex::encode(bytes)
}

pub fn is_hex32(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
