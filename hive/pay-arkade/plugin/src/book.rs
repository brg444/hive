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
    /// Buyer: the provider says it claimed. Closed once the escrow's coin is seen spent; returned
    /// after the deadline if it never is.
    Closing,
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
    /// Buyer: what the provider reported when it said it claimed: sats paid and returned.
    #[serde(default)]
    pub reported: Option<(u64, u64)>,
    /// Buyer: when a closing job's escrow was last looked at, and how many times so far.
    #[serde(default)]
    pub checked_at: u64,
    #[serde(default)]
    pub closing_checks: u32,
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
            reported: None,
            checked_at: 0,
            closing_checks: 0,
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
    /// Still under way: anything the clock or the other side can move forward.
    pub fn live(&self) -> bool {
        matches!(self.status, Status::Offered | Status::Quoted | Status::Open | Status::Closing)
    }
}

/// A settled job stays in the book this long after its deadline, then moves to the archive.
const KEEP_SETTLED_SECS: u64 = 30 * 86_400;

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

    /// The job with this peer that is still live (offered, quoted, open or closing), if any.
    pub fn live_with(&mut self, peer: &str) -> Option<&mut Job> {
        self.jobs.values_mut().find(|j| j.peer == peer && j.live())
    }

    /// Moves jobs settled long ago out of the book and into `jobs-archive.jsonl` beside it, one
    /// line each, so the book that is written whole on every change stays the size of the work
    /// under way. Returns how many moved; a job is archived before it leaves the book.
    pub fn archive_settled(&mut self, at: u64) -> Result<usize> {
        let old: Vec<String> = self
            .jobs
            .values()
            .filter(|j| !j.live() && j.deadline().max(j.created_at) + KEEP_SETTLED_SECS < at)
            .map(|j| j.job_id.clone())
            .collect();
        if old.is_empty() {
            return Ok(0);
        }
        use std::io::Write;
        let mut archive = std::fs::OpenOptions::new().create(true).append(true).open(self.path.with_file_name("jobs-archive.jsonl"))?;
        for id in &old {
            writeln!(archive, "{}", serde_json::to_string(&self.jobs[id])?)?;
        }
        archive.sync_all()?;
        for id in &old {
            self.jobs.remove(id);
        }
        self.save()?;
        Ok(old.len())
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
    fn archives_jobs_settled_long_ago_and_keeps_the_rest() {
        let dir = std::env::temp_dir().join(format!("pay-arkade-book-{}", crate::app::random_hex32()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut book = Book::open(dir.join("jobs.json")).unwrap();
        let t = now();
        for (id, status, created) in [("old", Status::Closed, t - 40 * 86_400), ("recent", Status::Expired, t - 86_400), ("live", Status::Open, t - 40 * 86_400)] {
            let mut job = Job::new(id.into(), "p".into(), status);
            job.created_at = created;
            book.jobs.insert(id.into(), job);
        }
        assert_eq!(book.archive_settled(t).unwrap(), 1);
        assert_eq!(book.jobs.keys().map(String::as_str).collect::<Vec<_>>(), ["live", "recent"]);
        let archived = std::fs::read_to_string(dir.join("jobs-archive.jsonl")).unwrap();
        assert!(archived.contains("\"job_id\":\"old\""));
        assert_eq!(Book::open(dir.join("jobs.json")).unwrap().jobs.len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prices_without_overflow() {
        assert_eq!(price_msat(1_000_000, 2_000_000), 2_000_000);
        assert_eq!(price_msat(u32::MAX as u64, u32::MAX as u64), (u32::MAX as u128 * u32::MAX as u128 / 1_000_000) as u64);
    }
}
