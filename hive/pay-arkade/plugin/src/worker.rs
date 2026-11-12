//! The contract worker as a child process. Requests go out as JSON lines on its stdin;
//! answers come back on its stdout tagged with the request's id, in any order.
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};

type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// A spend waits on the operator and the emulator; give it room, but never hang a hook forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

pub struct Worker {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next: AtomicU64,
    _child: Child,
}

impl Worker {
    pub async fn spawn(program: &Path, args: &[String]) -> Result<Arc<Self>> {
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
        let reader_pending = pending.clone();
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
            // The worker is gone: fail everything still waiting rather than leave it hanging.
            for (_, tx) in reader_pending.lock().unwrap().drain() {
                let _ = tx.send(Err("worker exited".into()));
            }
        });
        let worker = Arc::new(Self { stdin: Mutex::new(stdin), pending, next: AtomicU64::new(1), _child: child });
        worker.call("ping", json!({})).await.context("worker did not answer ping")?;
        Ok(worker)
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
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut line = serde_json::to_vec(&Value::Object(request))?;
        line.push(b'\n');
        {
            let mut stdin = self.stdin.lock().await;
            if let Err(e) = async { stdin.write_all(&line).await?; stdin.flush().await }.await {
                self.pending.lock().unwrap().remove(&id);
                return Err(anyhow!("writing to worker: {e}"));
            }
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(anyhow!("{op}: {message}")),
            Ok(Err(_)) => Err(anyhow!("{op}: worker dropped the request")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(anyhow!("{op}: worker timed out"))
            }
        }
    }
}
