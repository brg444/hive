//! Request bodies, which MeshLLM delivers on a side stream before it calls the hook.
//!
//! The host opens a stream per body, connects, writes the token we gave it and then the exact
//! request bytes, and waits for a receipt line `{"sha256": .., "byte_count": ..}`. Only after the
//! receipt does it invoke the hook, so a body stored here before the receipt is written is always
//! available to the hook that follows.
use mesh_llm_plugin::{PluginError, PluginResult, bind_side_stream, proto};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Bodies are parsed and kept only up to this size; larger ones are still hashed and receipted.
const KEEP_BYTES: usize = 1024 * 1024;
/// Bodies awaiting their hook, oldest dropped first.
const KEEP_COUNT: usize = 256;

#[derive(Clone, Default)]
pub struct Bodies(Arc<Mutex<VecDeque<(String, Value)>>>);

impl Bodies {
    pub async fn open(&self, request: proto::OpenStreamRequest) -> PluginResult<Option<proto::OpenStreamResponse>> {
        if request.mode != proto::StreamMode::RawBytes as i32 || !request.bidirectional {
            return Err(PluginError::invalid_request("expected a bidirectional raw byte stream"));
        }
        let metadata: Value = serde_json::from_str(request.metadata_json.as_deref().unwrap_or("{}"))
            .map_err(|e| PluginError::invalid_request(e.to_string()))?;
        if metadata["receipt_protocol"] != "sha256-v1" {
            return Err(PluginError::invalid_request("expected the sha256-v1 receipt protocol"));
        }
        let kind = metadata["kind"].as_str().unwrap_or_default().to_string();
        // Kept for pricing: the body the client sent. Effective bodies are acknowledged unused.
        let keep = matches!(kind.as_str(), "openai_exchange_original" | "openai_exchange_request");
        if !keep && kind != "openai_exchange_effective" {
            return Err(PluginError::invalid_request("unsupported lifecycle stream"));
        }
        let exchange_id = metadata["exchange_id"]
            .as_str()
            .or(request.correlation_id.as_deref())
            .ok_or_else(|| PluginError::invalid_request("missing exchange id"))?
            .to_string();
        // Short socket names: macOS temp paths are long and sockaddr_un is not.
        let socket_id = uuid::Uuid::parse_str(&request.stream_id)
            .map_err(|e| PluginError::invalid_request(e.to_string()))?
            .simple()
            .to_string();
        let listener = bind_side_stream("pa", &socket_id[..16]).await.map_err(|e| PluginError::internal(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(listener.endpoint(), std::fs::Permissions::from_mode(0o600))
                .map_err(|e| PluginError::internal(e.to_string()))?;
        }
        let mut response = listener.open_stream_response(&request);
        let token = uuid::Uuid::new_v4().to_string();
        response.token = Some(token.clone());
        let store = self.clone();
        let expected = request.expected_bytes;
        tokio::spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(30), async {
                let stream = listener.accept().await?;
                let (mut read, mut write) = stream.into_split();
                let mut auth = [0u8; 36];
                read.read_exact(&mut auth).await?;
                anyhow::ensure!(auth == token.as_bytes(), "side stream token mismatch");
                let (mut digest, mut count, mut body) = (Sha256::new(), 0u64, Vec::new());
                let mut buffer = [0u8; 16 * 1024];
                loop {
                    let n = read.read(&mut buffer).await?;
                    if n == 0 {
                        break;
                    }
                    count += n as u64;
                    digest.update(&buffer[..n]);
                    if keep && body.len() + n <= KEEP_BYTES {
                        body.extend_from_slice(&buffer[..n]);
                    }
                }
                if let Some(expected) = expected {
                    anyhow::ensure!(expected == count, "incomplete body stream");
                }
                if keep && body.len() as u64 == count
                    && let Ok(parsed) = serde_json::from_slice::<Value>(&body)
                {
                    store.put(exchange_id, parsed);
                }
                let receipt = serde_json::json!({"sha256": hex::encode(digest.finalize()), "byte_count": count});
                write.write_all(format!("{receipt}\n").as_bytes()).await?;
                write.shutdown().await?;
                anyhow::Ok(())
            })
            .await;
            if !matches!(result, Ok(Ok(()))) {
                eprintln!("pay-arkade: request body stream failed");
            }
        });
        Ok(Some(response))
    }

    fn put(&self, exchange_id: String, body: Value) {
        let mut bodies = self.0.lock().unwrap();
        bodies.retain(|(id, _)| *id != exchange_id);
        if bodies.len() >= KEEP_COUNT {
            bodies.pop_front();
        }
        bodies.push_back((exchange_id, body));
    }

    /// The body for this exchange, removed once taken.
    pub fn take(&self, exchange_id: &str) -> Option<Value> {
        let mut bodies = self.0.lock().unwrap();
        let index = bodies.iter().position(|(id, _)| id == exchange_id)?;
        bodies.remove(index).map(|(_, body)| body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn deliver(bodies: &Bodies, kind: &str, exchange: &str, bytes: &[u8]) -> Value {
        let response = bodies
            .open(proto::OpenStreamRequest {
                stream_id: uuid::Uuid::new_v4().to_string(),
                purpose: proto::StreamPurpose::HttpResponseBody as i32,
                mode: proto::StreamMode::RawBytes as i32,
                bidirectional: true,
                metadata_json: Some(serde_json::json!({"kind": kind, "exchange_id": exchange, "receipt_protocol": "sha256-v1"}).to_string()),
                expected_bytes: Some(bytes.len() as u64),
                ..Default::default()
            })
            .await
            .unwrap()
            .unwrap();
        let stream = mesh_llm_plugin::connect_side_stream(response.endpoint.as_deref().unwrap(), response.transport_kind)
            .await
            .unwrap();
        let (mut read, mut write) = stream.into_split();
        write.write_all(response.token.unwrap().as_bytes()).await.unwrap();
        write.write_all(bytes).await.unwrap();
        write.shutdown().await.unwrap();
        let mut ack = Vec::new();
        read.read_to_end(&mut ack).await.unwrap();
        serde_json::from_slice(&ack).unwrap()
    }

    #[tokio::test]
    async fn keeps_the_original_body_and_receipts_its_digest() {
        let bodies = Bodies::default();
        let bytes = br#"{"model":"m","max_tokens":12,"messages":[]}"#;
        let ack = deliver(&bodies, "openai_exchange_original", "x1", bytes).await;
        assert_eq!(ack["sha256"], hex::encode(Sha256::digest(bytes)));
        assert_eq!(ack["byte_count"], bytes.len());
        assert_eq!(bodies.take("x1").unwrap()["max_tokens"], 12);
        assert!(bodies.take("x1").is_none());
    }

    #[tokio::test]
    async fn acknowledges_effective_bodies_without_keeping_them() {
        let bodies = Bodies::default();
        let ack = deliver(&bodies, "openai_exchange_effective", "x2", b"{}").await;
        assert_eq!(ack["byte_count"], 2);
        assert!(bodies.take("x2").is_none());
    }
}
