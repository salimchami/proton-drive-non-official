//! Client of the drive-sync daemon socket: one JSON object per line (see daemon/src/ipc/protocol.ts).
//! Responses are matched to requests by id; pushed events are re-emitted to the webview.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::{oneshot, Mutex};

use crate::update;

const RECONNECT_DELAY: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct DaemonClient {
    writer: Mutex<Option<OwnedWriteHalf>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    /// Set while an update restart is being checked or waits for the daemon to be idle.
    pub restart_pending: AtomicBool,
}

impl DaemonClient {
    /// Sends a request and returns its `result`, or the daemon's error message.
    pub async fn request(&self, mut request: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        request["id"] = Value::from(id);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        let line = format!("{request}\n");
        let written = match self.writer.lock().await.as_mut() {
            Some(writer) => writer.write_all(line.as_bytes()).await.map_err(|e| e.to_string()),
            None => Err("the drive-sync daemon is not running".to_string()),
        };
        if let Err(error) = written {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        let response = tokio::time::timeout(REQUEST_TIMEOUT, receiver)
            .await
            .map_err(|_| "the daemon did not answer".to_string())?
            .map_err(|_| "the daemon connection was closed".to_string())?;
        if response["ok"].as_bool() == Some(true) {
            Ok(response["result"].clone())
        } else {
            Err(response["error"].as_str().unwrap_or("unknown daemon error").to_string())
        }
    }

    /// Keeps a connection to the daemon open, reconnecting while it is down.
    pub async fn run(self: Arc<Self>, app: AppHandle) {
        loop {
            if let Ok(stream) = UnixStream::connect(socket_path()).await {
                let (reader, writer) = stream.into_split();
                *self.writer.lock().await = Some(writer);
                let _ = app.emit("daemon-connection", true);
                tauri::async_runtime::spawn(update::restart_if_outdated(self.clone()));

                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if message.get("event").is_some() {
                        if message["event"] == "outdated" {
                            tauri::async_runtime::spawn(update::restart_if_outdated(self.clone()));
                        }
                        let _ = app.emit("daemon-event", message);
                    } else if let Some(id) = message["id"].as_u64() {
                        if let Some(sender) = self.pending.lock().await.remove(&id) {
                            let _ = sender.send(message);
                        }
                    }
                }

                *self.writer.lock().await = None;
                // Dropping the senders fails the requests still waiting.
                self.pending.lock().await.clear();
                let _ = app.emit("daemon-connection", false);
            }
            tokio::time::sleep(RECONNECT_DELAY).await;
        }
    }
}

fn socket_path() -> PathBuf {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").unwrap_or_default();
    PathBuf::from(runtime_dir).join("drive-sync").join("daemon.sock")
}
