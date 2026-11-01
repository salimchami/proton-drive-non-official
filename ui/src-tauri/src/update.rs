//! Restarts the daemon's systemd user service once a newer daemon is installed
//! (the daemon detects it, see daemon/src/update.ts).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::daemon::DaemonClient;

const SERVICE: &str = "drive-sync.service";
/// A restart would interrupt these: it waits for them to end.
const BUSY_STATES: [&str; 2] = ["syncing", "signingIn"];
const BUSY_POLL: Duration = Duration::from_secs(10);

/// Asks the daemon whether it is outdated and, if so, restarts it as soon as it is not busy.
pub async fn restart_if_outdated(client: Arc<DaemonClient>) {
    if client.restart_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(error) = check_and_restart(&client).await {
        eprintln!("drive-sync: daemon update check failed: {error}");
    }
    client.restart_pending.store(false, Ordering::SeqCst);
}

async fn check_and_restart(client: &DaemonClient) -> Result<(), String> {
    if client.request(json!({ "method": "outdated" })).await? != Value::Bool(true) {
        return Ok(());
    }
    loop {
        let status = client.request(json!({ "method": "status" })).await?;
        let state = status["state"].as_str().unwrap_or_default();
        if !BUSY_STATES.contains(&state) {
            break;
        }
        tokio::time::sleep(BUSY_POLL).await;
    }
    restart_service().await.map_err(|error| error.to_string())
}

async fn restart_service() -> zbus::Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some("org.freedesktop.systemd1"),
            "/org/freedesktop/systemd1",
            Some("org.freedesktop.systemd1.Manager"),
            "RestartUnit",
            &(SERVICE, "replace"),
        )
        .await?;
    Ok(())
}
