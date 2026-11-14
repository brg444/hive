//! The contract worker as a child process. Requests go out as JSON lines on its stdin;
//! answers come back on its stdout tagged with the request's id, in any order.
//!
//! The worker holds the key and talks to the Operator, so a plugin without one can neither claim
//! nor return an escrow. When it exits it is started again on the next call, with the same key
//! file and arguments: everything it knows is on disk or at the Operator.
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};

type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// A spend waits on the operator and the emulator; give it room, but never hang a hook forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// A worker that keeps exiting is started again no more often than this.
const RESTART_EVERY: Duration = Duration::from_secs(5);

/// One running worker: its stdin, the calls waiting on it, and whether it is still there.
struct Running {
    stdin: ChildStdin,
    pending: Pending,
    alive: Arc<AtomicBool>,
    started: Instant,
    _child: Child,
}

pub struct Worker {
    program: PathBuf,
    args: Vec<String>,
    running: Mutex<Running>,
    next: AtomicU64,
}

impl Worker {
    pub async fn spawn(program: &Path, args: &[String]) -> Result<Arc<Self>> {
        let running = Self::start(program, args)?;
        let worker = Arc::new(Self { program: program.to_path_buf(), args: args.to_vec(), running: Mutex::new(running), next: AtomicU64::new(1) });
        worker.call("ping", json!({})).await.context("worker did not answer ping")?;
        Ok(worker)
    }

    fn start(program: &Path, args: &[String]) -> Result<Running> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("starting worker {}", program.display()))?;
        let stdin = child.stdin.take().context("worker stdin")?;
        let stdout = child.stdout.take().context("worker stdout")?;
        let pending: Pending = Default::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (reader_pending, reader_alive) = (pending.clone(), alive.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(id) = msg["id"].as_u64() else { continue };
                let Some(tx) = reader_pending.lock().unwrap().remove(&id) else { continue };
                let result = match msg.get("ok") {
                    Some(ok) => Ok(ok.clone()),
                    None => Err(msg["error"].as_str().unwrap_or("worker error").to_string()),
                };
                let _ = tx.send(result);
            }
            // The worker is gone: fail everything still waiting on it rather than leave it hanging.
            // The next call starts another.
            reader_alive.store(false, Ordering::SeqCst);
            for (_, tx) in reader_pending.lock().unwrap().drain() {
                let _ = tx.send(Err("worker exited".into()));
            }
        });
        Ok(Running { stdin, pending, alive, started: Instant::now(), _child: child })
    }

    pub async fn call(&self, op: &str, body: Value) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut request = match body {
            Value::Object(map) => map,
            Value::Null => Default::default(),
            other => bail!("worker request body must be an object, got {other}"),
        };
        request.insert("id".into(), id.into());
        request.insert("op".into(), op.into());
        let mut line = serde_json::to_vec(&Value::Object(request))?;
        line.push(b'\n');
        let (tx, rx) = oneshot::channel();
        let pending = {
            let mut running = self.running.lock().await;
            if !running.alive.load(Ordering::SeqCst) {
                if running.started.elapsed() < RESTART_EVERY {
                    bail!("{op}: the worker exited; it is started again shortly");
                }
                *running = Self::start(&self.program, &self.args).context("starting the worker again")?;
                eprintln!("pay-arkade: the contract worker had exited and was started again");
            }
            // Registered with the worker it is written to, so another worker's exit cannot fail it.
            running.pending.lock().unwrap().insert(id, tx);
            if let Err(e) = async { running.stdin.write_all(&line).await?; running.stdin.flush().await }.await {
                running.pending.lock().unwrap().remove(&id);
                running.alive.store(false, Ordering::SeqCst);
                return Err(anyhow!("writing to worker: {e}"));
            }
            running.pending.clone()
        };
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(anyhow!("{op}: {message}")),
            Ok(Err(_)) => Err(anyhow!("{op}: worker dropped the request")),
            Err(_) => {
                pending.lock().unwrap().remove(&id);
                Err(anyhow!("{op}: worker timed out"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in worker: answers every request with its own process id, and exits when told to.
    fn stand_in() -> (PathBuf, Vec<String>) {
        let script = r#"while read -r line; do id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/'); case "$line" in *'"op":"exit"'*) exit 0;; esac; printf '{"id":%s,"ok":{"pid":%s}}\n' "$id" "$$"; done"#;
        (PathBuf::from("/bin/sh"), vec!["-c".into(), script.into()])
    }

    #[tokio::test]
    async fn a_worker_that_exits_is_started_again_on_a_later_call() {
        let (program, args) = stand_in();
        let worker = Worker::spawn(&program, &args).await.unwrap();
        let first = worker.call("ping", json!({})).await.unwrap()["pid"].as_u64().unwrap();
        assert!(worker.call("exit", json!({})).await.is_err());
        // At once, the call is refused rather than a worker started in a loop; a little later, one is.
        worker.running.lock().await.started = Instant::now();
        assert!(worker.call("ping", json!({})).await.unwrap_err().to_string().contains("started again shortly"));
        worker.running.lock().await.started = Instant::now() - RESTART_EVERY;
        let second = worker.call("ping", json!({})).await.unwrap()["pid"].as_u64().unwrap();
        assert_ne!(first, second);
    }
}
