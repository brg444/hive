//! The hive agent's gateway: runs members' requests on the hive's budget.
//!
//! A member's node forwards an OpenAI request over the peer channel. The agent checks the sender,
//! authenticated by the mesh, against the members file the hive's coordinator writes, checks what
//! that member has spent today against their allowance, and runs the request through its own node,
//! where the payment hooks route it to a provider with an open job and receipt it like any other.
//! Usage is logged per member and per proposal; prompts and answers are never logged.
use crate::app::App;
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

/// Millisats spent per member on the current UTC day, persisted so a restart cannot reset it.
#[derive(Serialize, Deserialize, Default)]
pub struct Usage {
    day: u64,
    spent_msat: HashMap<String, u64>,
}

impl Usage {
    fn roll(&mut self) {
        let today = now() / 86_400;
        if self.day != today {
            self.day = today;
            self.spent_msat.clear();
        }
    }
}

impl App {
    fn usage_path(&self) -> std::path::PathBuf {
        self.cfg.state_dir.join("usage.json")
    }

    fn load_usage(&self) -> Usage {
        std::fs::read(self.usage_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
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
        let spent = {
            let mut usage = self.load_usage();
            usage.roll();
            usage.spent_msat.get(peer).copied().unwrap_or(0)
        };
        if spent >= entry.allowance_sats_per_day * 1000 {
            self.log(json!({"event": "member_refused", "member": peer, "reason": "allowance spent", "spent_msat": spent}));
            return Ok((429, error_body("today's allowance on this hive is spent", "allowance_spent")));
        }
        let model = entry.model.clone().or(file.model.clone()).unwrap_or_else(|| self.cfg.models[0].clone());
        let mut request = body;
        if let Some(object) = request.as_object_mut() {
            object.remove("model");
            object.remove("stream");
        }
        let response = ctx
            .infer(HostInferenceRequest { model_id: model.clone(), target_node_id: None, request, timeout_ms: Some(120_000) })
            .await?;
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
            let mut usage = self.load_usage();
            usage.roll();
            *usage.spent_msat.entry(peer.to_string()).or_insert(0) += msat;
            let _ = std::fs::write(self.usage_path(), serde_json::to_vec(&usage)?);
        }
        self.log(json!({"event": "member_usage", "member": peer, "name": entry.name, "proposal": entry.proposal,
            "model": model, "status": response.status_code, "tokens": tokens, "msat": msat, "priced": price.is_some(),
            "served_by": response.served_by}));
        Ok((response.status_code, response.body))
    }
}
