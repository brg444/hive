//! The hive agent's gateway: runs members' requests on the hive's budget.
//!
//! A member's node forwards an OpenAI request over the peer channel. The agent checks the sender,
//! authenticated by the mesh, against the members file the hive's coordinator writes, checks what
//! that member has spent today and has under way against their allowance, and runs the request through its own node,
//! where the payment hooks route it to a provider with an open job and receipt it like any other.
//! Usage is logged per member and per proposal; prompts and answers are never logged.
use crate::app::{App, most_tokens};
use crate::book::{Status, now, price_msat};
use crate::protocol::{Message, error_body};
use anyhow::{Context, Result};
use mesh_llm_plugin::{HostInferenceRequest, PluginContext};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

/// Written by the coordinator from approved proposals; read on every request, so edits apply at once.
#[derive(Deserialize, Debug)]
pub struct MembersFile {
    /// The model members' requests run on when their entry names none.
    #[serde(default)]
    pub model: Option<String>,
    /// Keyed by the member's node id, as the mesh authenticates it.
    pub members: HashMap<String, MemberEntry>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct MemberEntry {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub proposal: Option<String>,
    pub allowance_sats_per_day: u64,
    #[serde(default)]
    pub model: Option<String>,
}

/// Millisats spent per member on the current UTC day, persisted so a restart cannot reset it, and
/// the worst case of each member's requests still under way, which a restart ends anyway.
///
/// One copy, in memory, behind the app's lock: a request is counted against the allowance from the
/// moment it is admitted, so a member cannot spend past it by sending many at once, and two members
/// finishing together cannot lose one another's count.
#[derive(Serialize, Deserialize, Default)]
pub struct Usage {
    day: u64,
    spent_msat: HashMap<String, u64>,
    #[serde(skip)]
    under_way_msat: HashMap<String, u64>,
}

impl Usage {
    /// Today's usage as it was last written; nothing when there is none yet.
    pub fn load(path: &std::path::Path) -> Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("usage.json does not parse; move it aside to start today's count again"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    fn roll(&mut self) {
        let today = now() / 86_400;
        if self.day != today {
            self.day = today;
            self.spent_msat.clear();
        }
    }

    /// Written whole, then moved into place: a crash leaves the old count or the new, never half of one.
    fn save(&self, path: &std::path::Path) -> Result<()> {
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    fn release(&mut self, member: &str, msat: u64) {
        if let Some(under_way) = self.under_way_msat.get_mut(member) {
            *under_way = under_way.saturating_sub(msat);
            if *under_way == 0 {
                self.under_way_msat.remove(member);
            }
        }
    }
}

impl App {
    fn usage_path(&self) -> std::path::PathBuf {
        self.cfg.state_dir.join("usage.json")
    }

    /// Answer one member request. Always replies, refusals included, so the member never hangs.
    pub async fn gateway(self: &Arc<Self>, peer: String, id: String, body: Value, ctx: &mut PluginContext<'_>) {
        let (status, answer) = match self.gateway_answer(&peer, body, ctx).await {
            Ok(answer) => answer,
            Err(e) => {
                self.log(json!({"event": "error", "from": peer, "error": format!("gateway: {e}")}));
                (502, error_body("the hive could not run this request", "hive_error"))
            }
        };
        let reply = Message::GatewayResponse { id, status, body: answer };
        if let Err(e) = self.send(ctx, &peer, &reply).await {
            self.log(json!({"event": "error", "to": peer, "error": format!("gateway reply: {e}")}));
        }
    }

    async fn gateway_answer(&self, peer: &str, body: Value, ctx: &mut PluginContext<'_>) -> Result<(u16, Value)> {
        let Some(path) = &self.cfg.members_file else {
            return Ok((404, error_body("this node does not run requests for members", "not_a_gateway")));
        };
        let file: MembersFile = serde_json::from_slice(&std::fs::read(path).context("reading the members file")?)
            .context("parsing the members file")?;
        let Some(entry) = file.members.iter().find(|(k, _)| k.eq_ignore_ascii_case(peer)).map(|(_, v)| v.clone()) else {
            self.log(json!({"event": "member_refused", "member": peer, "reason": "not a member"}));
            // The id comes from the mesh's authenticated connection, so it is exactly what keepers add.
            let message = format!("this node ({peer}) is not a member of the hive; give this id to the hive's keepers");
            return Ok((403, error_body(&message, "not_a_member")));
        };
        let model = entry.model.clone().or(file.model.clone()).unwrap_or_else(|| self.cfg.models[0].clone());
        let mut request = body;
        if let Some(object) = request.as_object_mut() {
            object.remove("model");
            object.remove("stream");
        }
        // The request's worst case, at the most this hive pays, is set aside while it runs: what a
        // member has under way counts against today's allowance with what they have spent.
        let worst = most_tokens(&json!({"body": request}), self.cfg.max_unnamed_output_tokens)
            .map_or(0, |tokens| price_msat(tokens, self.cfg.max_price_msat_per_mtok));
        {
            let mut usage = self.usage.lock().unwrap();
            usage.roll();
            let spent = usage.spent_msat.get(peer).copied().unwrap_or(0);
            let under_way = usage.under_way_msat.get(peer).copied().unwrap_or(0);
            if spent.saturating_add(under_way) >= entry.allowance_sats_per_day.saturating_mul(1000) {
                drop(usage);
                self.log(json!({"event": "member_refused", "member": peer, "reason": "allowance spent", "spent_msat": spent, "under_way_msat": under_way}));
                return Ok((429, error_body("today's allowance on this hive is spent", "allowance_spent")));
            }
            *usage.under_way_msat.entry(peer.to_string()).or_insert(0) += worst;
        }
        let answered = ctx
            .infer(HostInferenceRequest { model_id: model.clone(), target_node_id: None, request, timeout_ms: Some(120_000) })
            .await;
        // However the request ended, it is no longer under way.
        self.usage.lock().unwrap().release(peer, worst);
        let response = answered?;
        // Price the answer the way its receipt was priced: the served job's signed quote.
        let usage = &response.body["usage"];
        let tokens = usage["prompt_tokens"].as_u64().unwrap_or(0) + usage["completion_tokens"].as_u64().unwrap_or(0);
        let price = {
            let book = self.book.lock().unwrap();
            let open = |j: &&crate::book::Job| j.status == Status::Open;
            let by_server = response.served_by.as_deref().and_then(|s| {
                book.jobs.values().filter(open).find(|j| j.peer.eq_ignore_ascii_case(s)).and_then(|j| j.quote.clone())
            });
            by_server
                .or_else(|| book.jobs.values().filter(open).find(|j| j.quote.as_ref().is_some_and(|q| q.model == model)).and_then(|j| j.quote.clone()))
                .map(|q| q.price_msat_per_mtok)
        };
        let msat = price.map_or(0, |p| price_msat(tokens, p));
        if response.status_code == 200 {
            let mut usage = self.usage.lock().unwrap();
            usage.roll();
            *usage.spent_msat.entry(peer.to_string()).or_insert(0) += msat;
            if let Err(e) = usage.save(&self.usage_path()) {
                drop(usage);
                self.log(json!({"event": "error", "error": format!("saving members' usage: {e}")}));
            }
        }
        self.log(json!({"event": "member_usage", "member": peer, "name": entry.name, "proposal": entry.proposal,
            "model": model, "status": response.status_code, "tokens": tokens, "msat": msat, "priced": price.is_some(),
            "served_by": response.served_by}));
        Ok((response.status_code, response.body))
    }
}
