//! Jobs, persisted. A seller's book holds the receipts it will be paid on, so every change is
//! written to disk before the plugin acts on it.
use crate::protocol::Quote;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// The smallest output Arkade accepts. A claim below it cannot be made; the job expires instead.
pub const DUST_SATS: u64 = 330;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Buyer: offer sent, no quote yet.
    Offered,
    /// Quote agreed; waiting for the treasury to fund the escrow.
    Quoted,
    /// The escrow holds the cap; requests flow.
    Open,
    /// Claimed by the provider.
    Closed,
    /// Returned to the treasury after the deadline, or never funded.
    Expired,
    /// Unusable: funded with the wrong amount, or a claim failed past its deadline.
    Failed,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Job {
    pub job_id: String,
    pub peer: String,
    pub status: Status,
    pub quote: Option<Quote>,
    /// What the usage so far costs, in millisats. Seller: billed. Buyer: owed.
    pub usage_msat: u64,
    /// The latest receipt: cumulative sats and the agent's signature.
    pub receipt_sats: u64,
    pub receipt_sig: Option<String>,
    pub txid: Option<String>,
    pub note: Option<String>,
    /// Seller: worst-case cost of requests admitted but not finished, by exchange id.
    #[serde(default)]
    pub reserved: HashMap<String, (u64, u64)>, // exchange id → (msat, admitted at)
    pub created_at: u64,
    /// Seller: when the delegated renewal was last requested from the agent, and whether it is in place.
    #[serde(default)]
    pub renewal_requested_at: u64,
    #[serde(default)]
    pub renewal_registered: bool,
}

impl Job {
    pub fn new(job_id: String, peer: String, status: Status) -> Self {
        Self {
            job_id,
            peer,
            status,
            quote: None,
            usage_msat: 0,
            receipt_sats: 0,
            receipt_sig: None,
            txid: None,
            note: None,
            reserved: HashMap::new(),
            created_at: now(),
            renewal_requested_at: 0,
            renewal_registered: false,
        }
    }
    pub fn cap_msat(&self) -> u64 {
        self.quote.as_ref().map_or(0, |q| q.cap_sats * 1000)
    }
    pub fn deadline(&self) -> u64 {
        self.quote.as_ref().map_or(0, |q| q.deadline)
    }
    pub fn reserved_msat(&self) -> u64 {
        self.reserved.values().map(|(m, _)| m).sum()
    }
    /// Sats owed for the usage so far, rounded up: the provider is never short a fraction.
    pub fn usage_sats(&self) -> u64 {
        self.usage_msat.div_ceil(1000)
    }
}

pub struct Book {
    path: PathBuf,
    pub jobs: BTreeMap<String, Job>,
}

impl Book {
    pub fn open(path: PathBuf) -> Result<Self> {
        let jobs = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { path, jobs })
    }

    pub fn save(&self) -> Result<()> {
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.jobs)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }

    /// The job with this peer that is still live (offered, quoted or open), if any.
    pub fn live_with(&mut self, peer: &str) -> Option<&mut Job> {
        self.jobs
            .values_mut()
            .find(|j| j.peer == peer && matches!(j.status, Status::Offered | Status::Quoted | Status::Open))
    }
}

/// Cost of `tokens` at `price` millisats per million tokens.
pub fn price_msat(tokens: u64, price_msat_per_mtok: u64) -> u64 {
    ((tokens as u128 * price_msat_per_mtok as u128) / 1_000_000) as u64
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_owed_sats_up() {
        let mut job = Job::new("j".into(), "p".into(), Status::Open);
        job.usage_msat = 1;
        assert_eq!(job.usage_sats(), 1);
        job.usage_msat = 2000;
        assert_eq!(job.usage_sats(), 2);
    }

    #[test]
    fn prices_without_overflow() {
        assert_eq!(price_msat(1_000_000, 2_000_000), 2_000_000);
        assert_eq!(price_msat(u32::MAX as u64, u32::MAX as u64), (u32::MAX as u128 * u32::MAX as u128 / 1_000_000) as u64);
    }
}
