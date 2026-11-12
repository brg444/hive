//! What the two plugins say to each other on `pay.arkade.v1`, and the terms a seller publishes.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// An OpenAI-style error body.
pub fn error_body(message: &str, kind: &str) -> Value {
    json!({"error": {"message": message, "type": kind}})
}

pub const CHANNEL: &str = "pay.arkade.v1";

/// Published per model through `require_channels_for_model`; kept well under the 1 KiB cap.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Terms {
    pub v: u32,
    pub price_msat_per_mtok: u64,
    pub claim_key: String,
    pub min_cap_sats: u64,
    pub max_cap_sats: u64,
    pub max_deadline_secs: u64,
}

/// The provider's signed answer to an offer. Both plugins derive the escrow from it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Quote {
    pub job_id: String,
    pub model: String,
    pub price_msat_per_mtok: u64,
    pub cap_sats: u64,
    pub deadline: u64,
    pub agent_pk: String,
    pub provider_pk: String,
    pub treasury_program: String,
    pub escrow_address: String,
    /// The delegate service that renews the escrow (x-only key), when the provider uses one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegate_pk: Option<String>,
}

impl Quote {
    /// The escrow's constructor as the worker takes it.
    pub fn params(&self) -> Value {
        let mut p = json!({
            "agentPk": self.agent_pk,
            "providerPk": self.provider_pk,
            "treasuryProgram": self.treasury_program,
            "deadline": self.deadline,
            "jobId": self.job_id,
        });
        if let Some(d) = &self.delegate_pk {
            p["delegatePk"] = json!(d);
        }
        p
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Message {
    /// Buyer → seller: the job the buyer wants to fund.
    Offer { job_id: String, model: String, cap_sats: u64, deadline: u64, agent_pk: String, treasury_program: String },
    /// Seller → buyer: the terms it will serve the job on, signed with its claim key.
    Quote { quote: Quote, sig: String },
    /// Seller → buyer: the offer is refused.
    Decline { job_id: String, reason: String },
    /// Seller → buyer: the escrow holds exactly the cap; requests are admitted.
    Opened { job_id: String, locked_sats: u64 },
    /// Buyer → seller: the cumulative amount owed, signed with the agent key.
    Receipt { job_id: String, amount_sats: u64, sig: String },
    /// Buyer → seller: please claim now; no more requests are coming.
    Close { job_id: String },
    /// Seller → buyer: the job is settled.
    Closed { job_id: String, txid: Option<String>, paid_sats: u64, returned_sats: u64 },
    /// Seller → buyer: the escrow's renewal by the delegate service, to sign together (MuSig2 round one).
    RenewalRequest { job_id: String, request: Value },
    /// Buyer → seller: the agent's nonces and partial signatures for that renewal.
    RenewalAnswer { job_id: String, answer: Value },
    /// Member → the hive's agent: an OpenAI chat request to run on the hive's budget.
    GatewayRequest { id: String, body: Value },
    /// The hive's agent → member: the answer, or a refusal, with its HTTP status.
    GatewayResponse { id: String, status: u16, body: Value },
}

impl Message {
    pub fn label(&self) -> &'static str {
        match self {
            Message::Offer { .. } => "offer",
            Message::Quote { .. } => "quote",
            Message::Decline { .. } => "decline",
            Message::Opened { .. } => "opened",
            Message::Receipt { .. } => "receipt",
            Message::RenewalRequest { .. } => "renewal_request",
            Message::RenewalAnswer { .. } => "renewal_answer",
            Message::Close { .. } => "close",
            Message::Closed { .. } => "closed",
            Message::GatewayRequest { .. } => "gateway_request",
            Message::GatewayResponse { .. } => "gateway_response",
        }
    }
}
