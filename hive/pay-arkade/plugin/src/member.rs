//! The member's side of a hive: no keys and no wallet. The plugin publishes the hive as a model on
//! the member's own node, so any OpenAI-compatible tool pointed at that node can use it, and it
//! forwards each request to the hive's agent over the plugin's peer channel. The agent knows who
//! asked from the channel's authenticated sender, runs the request on the hive's budget, and
//! answers back.
//!
//! MeshLLM's virtual models are only visible on the node whose plugin declares them, which is why
//! the member runs this small role instead of calling a model published by the agent.
use crate::protocol::{CHANNEL, Message, error_body};
use anyhow::Result;
use mesh_llm_plugin::{
    PluginContext, PluginMetadata, PluginRuntime, SimplePlugin, VirtualModelInvocation, VirtualModelResponse,
    VirtualModelRouter, mesh_channel, operation_with_schema, plugin_manifest, plugin_server_info, virtual_model,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

pub struct MemberConfig {
    /// The hive agent's node id.
    pub agent: String,
    /// The model id the hive appears as on this node.
    pub model_id: String,
    pub log: Option<PathBuf>,
    pub timeout: Duration,
}

struct Member {
    cfg: MemberConfig,
    pending: Mutex<HashMap<String, oneshot::Sender<(u16, Value)>>>,
}

impl Member {
    fn log(&self, mut event: Value) {
        let Some(path) = &self.cfg.log else { return };
        use std::io::Write;
        event["at"] = json!(crate::book::now());
        event["role"] = json!("member");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{event}");
        }
    }

    async fn forward(&self, invocation: VirtualModelInvocation, ctx: &mut PluginContext<'_>) -> VirtualModelResponse {
        let id = crate::app::random_hex32()[..32].to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let request = Message::GatewayRequest { id: id.clone(), body: invocation.request };
        let started = std::time::Instant::now();
        if let Err(e) = ctx.send_json_channel(CHANNEL, &self.cfg.agent, request.label(), &request).await {
            self.pending.lock().unwrap().remove(&id);
            self.log(json!({"event": "gateway_unreachable", "id": id, "error": e.to_string()}));
            return respond(502, error_body("the hive's agent cannot be reached", "hive_unavailable"));
        }
        let (status, body) = match tokio::time::timeout(self.cfg.timeout, rx).await {
            Ok(Ok(answer)) => answer,
            _ => {
                self.pending.lock().unwrap().remove(&id);
                (504, error_body("the hive's agent did not answer in time", "hive_timeout"))
            }
        };
        self.log(json!({"event": "gateway_answer", "id": id, "status": status, "ms": started.elapsed().as_millis() as u64,
            "usage": body.get("usage")}));
        respond(status, body)
    }
}

fn respond(status: u16, body: Value) -> VirtualModelResponse {
    VirtualModelResponse { status_code: status, body, headers: Vec::new(), event_stream: false }
}

pub async fn run(cfg: MemberConfig, version: &str) -> Result<()> {
    let manifest = plugin_manifest()
        .item(mesh_channel(CHANNEL))
        .item(virtual_model(cfg.model_id.clone(), "hive_gateway"))
        .build();
    let metadata = PluginMetadata::new(
        "pay-arkade",
        version,
        plugin_server_info("pay-arkade", version, "Use a hive's budget from this node", "pay.arkade.v1", None::<String>),
    )
    .with_manifest(manifest);
    let member = Arc::new(Member { cfg, pending: Default::default() });
    member.log(json!({"event": "started", "agent": member.cfg.agent, "model": member.cfg.model_id}));

    let mut router = VirtualModelRouter::new();
    let gateway = member.clone();
    router.add_json(
        operation_with_schema("hive_gateway", "Run a request on the hive's budget", serde_json::Map::new()),
        move |invocation: VirtualModelInvocation, ctx| {
            let member = gateway.clone();
            let mut ctx = ctx.owned();
            Box::pin(async move { Ok(member.forward(invocation, &mut ctx).await) })
        },
    );
    let answers = member.clone();
    let plugin = SimplePlugin::new(metadata)
        .with_virtual_model_router(router)
        .on_channel_message(move |message, _ctx| {
            let member = answers.clone();
            Box::pin(async move {
                // Only the configured agent can answer; anything else on the channel is ignored.
                if !message.source_peer_id.eq_ignore_ascii_case(&member.cfg.agent) {
                    return Ok(());
                }
                if let Ok(Message::GatewayResponse { id, status, body }) = serde_json::from_slice(&message.body)
                    && let Some(tx) = member.pending.lock().unwrap().remove(&id)
                {
                    let _ = tx.send((status, body));
                }
                Ok(())
            })
        });
    PluginRuntime::run(plugin).await
}
