//! pay-arkade: pay for MeshLLM models in bitcoin on Arkade.
//!
//! One binary for every side. As `--role seller` on a provider's node it gates its models behind
//! `pay.arkade.v1` terms; as `--role buyer` on the hive agent's node it opens, receipts and closes
//! jobs, and runs members' requests; as `--role member` on a member's node it offers the hive as a
//! model. Keys and spends live in the contract worker, a separate executable sellers and buyers start.
mod app;
mod bodies;
mod book;
mod buyer;
mod gateway;
mod member;
mod protocol;
mod seller;
mod worker;

use anyhow::{Context, Result, bail};
use app::{App, Config, Role};
use book::Book;
use mesh_llm_plugin::openai_exchange::openai_exchange_hook;
use mesh_llm_plugin::{PluginError, PluginMetadata, PluginRuntime, SimplePlugin, mesh_channel, plugin_manifest, plugin_server_info};
use protocol::{CHANNEL, Message};
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const TICK: Duration = Duration::from_secs(3);

struct Args(Vec<String>);
impl Args {
    fn get(&self, name: &str) -> Option<String> {
        self.0.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
    }
    fn all(&self, name: &str) -> Vec<String> {
        self.0.windows(2).filter(|w| w[0] == name).map(|w| w[1].clone()).collect()
    }
    fn num(&self, name: &str, default: u64) -> Result<u64> {
        self.get(name).map_or(Ok(default), |v| v.parse().with_context(|| format!("{name} must be a number")))
    }
    fn has(&self, name: &str) -> bool {
        self.0.iter().any(|a| a == name)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args(std::env::args().collect());

    let mut hook = openai_exchange_hook("payment_gate");
    hook.required = true;
    hook.admission = true;
    hook.deadline_ms = 30_000;
    // The seller prices each request's worst case from its body, which the host streams to the
    // plugin before calling the hook. Without one, --default-max-tokens stands in.
    hook.request_body = true;
    let manifest = plugin_manifest().item(hook).item(mesh_channel(CHANNEL)).build();
    if args.has("--manifest") {
        println!("{}", mesh_llm_plugin::package_manifest_json(&manifest)?);
        return Ok(());
    }

    if args.get("--role").as_deref() == Some(app::MEMBER_ROLE) {
        return member::run(
            member::MemberConfig {
                agent: args.get("--agent").context("--agent <the hive agent's node id> is required for a member")?,
                model_id: args.get("--hive-model").unwrap_or_else(|| "hive".into()),
                log: args.get("--log").map(PathBuf::from),
                timeout: Duration::from_secs(args.num("--gateway-timeout-secs", 150)?),
            },
            VERSION,
        )
        .await;
    }
    let role = match args.get("--role").as_deref() {
        Some("seller") => Role::Seller,
        Some("buyer") => Role::Buyer,
        _ => bail!("--role seller|buyer|member is required"),
    };
    let state_dir = PathBuf::from(args.get("--state-dir").context("--state-dir <dir> is required")?);
    std::fs::create_dir_all(&state_dir)?;
    let cfg = Config {
        role,
        models: args.all("--model"),
        log: args.get("--log").map(PathBuf::from),
        default_max_tokens: args.num("--default-max-tokens", 1024)?,
        network: args.get("--network").unwrap_or_else(|| "regtest".into()),
        allow_peers: args.all("--allow-peer"),
        min_coin_life_secs: args.num("--min-coin-life-secs", 86_400)?,
        executor: args.get("--executor"),
        delegate: args.get("--delegate"),
        renew_after_secs: args.get("--renew-after-secs").map(|v| v.parse()).transpose()?,
        max_open_sats: args.num("--max-open-sats", 100_000)?,
        price_msat_per_mtok: args.num("--price-msat-per-mtok", 2_000_000)?,
        min_cap_sats: args.num("--min-cap-sats", 1_000)?,
        max_cap_sats: args.num("--max-cap-sats", 1_000_000)?,
        max_deadline_secs: args.num("--max-deadline-secs", 7 * 86_400)?,
        close_margin_secs: args.num("--close-margin-secs", 600)?,
        max_unreceipted_sats: args.num("--max-unreceipted-sats", 1_000)?,
        payout_pk_script: args.get("--payout-pk-script"),
        cap_sats: args.num("--cap-sats", 20_000)?,
        period_secs: args.num("--period-secs", 86_400)?,
        max_price_msat_per_mtok: args.num("--max-price-msat-per-mtok", 10_000_000)?,
        treasury_program: args.get("--treasury-program"),
        funding_queue: args.get("--funding-queue").map(PathBuf::from),
        expire_grace_secs: args.num("--expire-grace-secs", 60)?,
        members_file: args.get("--members-file").map(PathBuf::from),
        state_dir: state_dir.clone(),
    };
    if cfg.models.is_empty() {
        bail!("at least one --model is required");
    }
    // Mainnet stays gated: a node deals only with the peers it names, unless told otherwise.
    if cfg.network == "bitcoin" && cfg.allow_peers.is_empty() && !args.has("--allow-any-peer") {
        bail!("on mainnet, name the peers this node deals with (--allow-peer <node id>), or pass --allow-any-peer");
    }
    if role == Role::Buyer && cfg.treasury_program.is_none() {
        bail!("--treasury-program is required for a buyer");
    }

    // The worker ships beside this binary unless told otherwise.
    let worker_path = match args.get("--worker") {
        Some(p) => PathBuf::from(p),
        None => std::env::current_exe()?.with_file_name("pay-arkade-worker"),
    };
    let key_file = args.get("--key-file").map(PathBuf::from).unwrap_or_else(|| state_dir.join("key"));
    let mut worker_args = vec!["--key-file".to_string(), key_file.display().to_string()];
    for flag in ["--operator", "--emulator", "--network", "--executor", "--delegate"] {
        if let Some(value) = args.get(flag) {
            worker_args.extend([flag.to_string(), value]);
        }
    }
    let worker = worker::Worker::spawn(&worker_path, &worker_args).await?;
    let pubkey = worker.call("ping", json!({})).await?["pubkey"].as_str().context("worker pubkey")?.to_string();
    let mut book = Book::open(state_dir.join("jobs.json"))?;
    // No request survives a restart, so reservations held for in-flight requests are stale.
    for job in book.jobs.values_mut() {
        job.reserved.clear();
    }
    let app = Arc::new(App {
        book: Mutex::new(book),
        cfg,
        worker,
        pubkey,
        exchanges: Default::default(),
        busy: Default::default(),
    });
    app.log(json!({"event": "started", "pubkey": app.pubkey, "models": app.cfg.models}));

    let metadata = PluginMetadata::new(
        "pay-arkade",
        VERSION,
        plugin_server_info("pay-arkade", VERSION, "Pay for models in bitcoin on Arkade", "pay.arkade.v1", None::<String>),
    )
    .with_manifest(manifest);

    let bodies = bodies::Bodies::default();
    let (stream_bodies, hook_bodies) = (bodies.clone(), bodies);
    let (init_app, msg_app, hook_app) = (app.clone(), app.clone(), app.clone());
    let plugin = SimplePlugin::new(metadata)
        .on_initialized(move |context| {
            let app = init_app.clone();
            let mut context = context.owned();
            Box::pin(async move {
                if app.cfg.role == Role::Seller {
                    let terms = serde_json::to_vec(&app.terms()).map_err(|e| PluginError::internal(e.to_string()))?;
                    for model in &app.cfg.models {
                        context
                            .require_channels_for_model(model, &[(CHANNEL, terms.as_slice())])
                            .await
                            .map_err(|e| PluginError::internal(e.to_string()))?;
                    }
                    app.log(json!({"event": "terms_published", "models": app.cfg.models, "terms": app.terms()}));
                }
                // Funding, claims and expiry run on a clock, not on a request.
                let ticker = app.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(TICK).await;
                        match ticker.cfg.role {
                            Role::Seller => ticker.seller_tick(&mut context).await,
                            Role::Buyer => ticker.buyer_tick().await,
                        }
                    }
                });
                Ok(())
            })
        })
        .on_channel_message(move |message, context| {
            let app = msg_app.clone();
            let mut context = context.owned();
            Box::pin(async move {
                let peer = message.source_peer_id.clone();
                let body: Message = match serde_json::from_slice(&message.body) {
                    Ok(body) => body,
                    Err(e) => {
                        app.log(json!({"event": "bad_message", "from": peer, "error": e.to_string()}));
                        return Ok(());
                    }
                };
                // A member's request can take a while to answer; it must not hold up receipts.
                if let Message::GatewayRequest { id, body } = body {
                    if app.cfg.role == Role::Buyer {
                        app.log(json!({"event": "received", "from": peer, "message": {"kind": "gateway_request", "id": id}}));
                        let app = app.clone();
                        tokio::spawn(async move { app.gateway(peer, id, body, &mut context).await });
                    }
                    return Ok(());
                }
                app.log(json!({"event": "received", "from": peer, "message": body}));
                let result = match app.cfg.role {
                    Role::Seller => app.seller_message(&peer, body, &mut context).await,
                    Role::Buyer => app.buyer_message(&peer, body, &mut context).await,
                };
                if let Err(e) = result {
                    app.log(json!({"event": "error", "from": peer, "error": e.to_string()}));
                }
                Ok(())
            })
        })
        .on_open_stream(move |request, _context| {
            let bodies = stream_bodies.clone();
            Box::pin(async move {
                let opened = bodies.open(request).await;
                if let Err(e) = &opened {
                    eprintln!("pay-arkade: refused a body stream: {e}");
                }
                opened
            })
        })
        .with_openai_exchange_handler(move |_name, event, context| {
            let app = hook_app.clone();
            let bodies = hook_bodies.clone();
            let mut context = context.owned();
            Box::pin(async move {
                // A streamed body arrives before its hook; put it where small bodies already are.
                let mut event = event;
                if event["phase"] == "request_received"
                    && let Some(body) = event["exchange_id"].as_str().and_then(|id| bodies.take(id))
                    && event["body"].is_null()
                {
                    event["body"] = body;
                }
                if std::env::var_os("PAY_ARKADE_TRACE").is_some() {
                    app.log(json!({"event": "trace_hook", "phase": event["phase"], "exchange_id": event["exchange_id"]}));
                }
                let logged = |decision: &mesh_llm_plugin::openai_exchange::OpenAiExchangeDecision| {
                    if decision.reason.is_some() {
                        app.log(json!({"event": "denied", "phase": event["phase"], "exchange_id": event["exchange_id"],
                            "peer": event["requested_by_node_id"].as_str().or(event["target_peer_id"].as_str()),
                            "model": event["model"], "has_body": !event["body"].is_null(), "reason": decision.reason}));
                    }
                };
                match app.cfg.role {
                    Role::Seller => {
                        let decision = app.seller_exchange(&event);
                        logged(&decision);
                        Ok(decision)
                    }
                    Role::Buyer => {
                        if event["phase"] == "exchange_finished" {
                            if let Err(e) = app.buyer_finished(&event, &mut context).await {
                                app.log(json!({"event": "error", "error": e.to_string()}));
                            }
                            return Ok(Default::default());
                        }
                        let (decision, open_with) = app.buyer_exchange(&event);
                        logged(&decision);
                        if let Some((peer, model)) = open_with {
                            let app = app.clone();
                            let mut context = context.owned();
                            tokio::spawn(async move {
                                if let Err(e) = app.offer(peer, model, &mut context).await {
                                    app.log(json!({"event": "error", "error": e.to_string()}));
                                }
                            });
                        }
                        Ok(decision)
                    }
                }
            })
        });
    PluginRuntime::run(plugin).await
}
