<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { open as pickFolder } from "@tauri-apps/plugin-dialog";
  import { openUrl } from "@tauri-apps/plugin-opener";

  import { type Activity, daemon, type Settings, type Status } from "$lib/daemon";

  const THIRD_PARTY_NOTICE = "This is a third-party application not officially supported by Proton.";

  const STATE_LABELS: Record<Status["state"], string> = {
    signedOut: "Signed out",
    signingIn: "Signing in…",
    needsSettings: "Setup required",
    starting: "Starting sync…",
    idle: "Up to date",
    syncing: "Syncing…",
    awaitingApproval: "Confirmation required",
    error: "Error",
  };

  let connected = $state(false);
  let status = $state<Status | undefined>();
  let activity = $state<Activity[]>([]);
  let editing = $state(false);
  let form = $state<Settings>({ localRoot: "", remotePath: "/" });
  let requestError = $state<string | undefined>();
  const unlisteners: (() => void)[] = [];

  async function refresh() {
    try {
      status = await daemon.status();
      activity = await daemon.recentActivity();
      connected = true;
    } catch {
      connected = false;
    }
  }

  onMount(async () => {
    unlisteners.push(
      await daemon.onConnection((isConnected) => {
        connected = isConnected;
        if (isConnected) void refresh();
      }),
      await daemon.onEvent((event) => {
        if (event.event === "status") status = event.status;
        else if (event.event === "activity") activity = [event.activity, ...activity].slice(0, 200);
      }),
    );
    await refresh();
  });

  onDestroy(() => unlisteners.forEach((unlisten) => unlisten()));

  async function run(action: () => Promise<unknown>) {
    requestError = undefined;
    try {
      await action();
    } catch (error) {
      requestError = String(error);
    }
  }

  function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  /** Bytes when the plan transfers files, otherwise operations. */
  function percent(progress: Extract<NonNullable<Status["progress"]>, { phase: "transferring" }>): number {
    const ratio =
      progress.bytesTotal > 0
        ? progress.bytesDone / progress.bytesTotal
        : progress.actionsDone / Math.max(progress.actionsTotal, 1);
    return Math.min(100, Math.floor(ratio * 100));
  }

  const signIn = () => run(async () => openUrl(await daemon.login()));

  function editSettings() {
    form = { ...(status?.settings ?? { localRoot: "", remotePath: "/" }) };
    editing = true;
  }

  async function chooseLocalFolder() {
    const folder = await pickFolder({ directory: true, multiple: false });
    if (typeof folder === "string") form.localRoot = folder;
  }

  const saveSettings = () =>
    run(async () => {
      await daemon.setSettings({ ...form, remotePath: `/${form.remotePath.replace(/^\/+/, "")}` });
      editing = false;
    });
</script>

<main>
  {#if !connected}
    <section class="card">
      <h1>Service stopped</h1>
      <p>The drive-sync daemon is not responding. Start it with <code>systemctl --user start drive-sync</code>.</p>
    </section>
  {:else if status?.state === "signedOut" || status?.state === "signingIn"}
    <section class="card">
      <h1>Sign in</h1>
      <p class="notice">{THIRD_PARTY_NOTICE}</p>
      {#if status.state === "signingIn" && status.signInUrl}
        <p>Finish signing in from your browser.</p>
        <button onclick={() => status?.signInUrl && openUrl(status.signInUrl)}>Reopen the sign-in page</button>
      {:else}
        <button class="primary" onclick={signIn}>Sign in with your browser</button>
      {/if}
      {#if status.error}<p class="error">{status.error}</p>{/if}
    </section>
  {:else if status?.state === "needsSettings" || editing}
    <section class="card">
      <h1>Synced folders</h1>
      <label>
        Local folder
        <span class="row">
          <input bind:value={form.localRoot} placeholder="/home/…/Drive" />
          <button onclick={chooseLocalFolder}>Choose…</button>
        </span>
      </label>
      <label>
        Drive folder (in "My files")
        <input bind:value={form.remotePath} placeholder="/" />
      </label>
      <p class="hint">Changing folders starts a full sync again.</p>
      <span class="row">
        <button class="primary" onclick={saveSettings} disabled={!form.localRoot}>Save</button>
        {#if editing}<button onclick={() => (editing = false)}>Cancel</button>{/if}
      </span>
    </section>
  {:else if status}
    <section class="card">
      <header class="row">
        <span class="dot {status.state}"></span>
        <h1>{STATE_LABELS[status.state]}</h1>
      </header>
      {#if status.error}<p class="error">{status.error}</p>{/if}
      {#if status.progress?.phase === "listing"}
        <p>Scanning Drive: {status.progress.folders.toLocaleString()} folders</p>
      {:else if status.progress?.phase === "transferring"}
        {@const progress = status.progress}
        <div class="progress">
          <progress value={percent(progress)} max="100"></progress>
          <span>{percent(progress)} %</span>
        </div>
        <p class="hint">
          {progress.actionsDone.toLocaleString()} / {progress.actionsTotal.toLocaleString()} operations
          {#if progress.bytesTotal > 0}· {formatBytes(progress.bytesDone)} / {formatBytes(progress.bytesTotal)}{/if}
        </p>
        {#if progress.currentPath}<p class="path" title={progress.currentPath}>{progress.currentPath}</p>{/if}
      {/if}
      {#if status.heldDeletions}
        <p>
          The sync would move {status.heldDeletions.count} files to the trash. Nothing is applied until you
          choose.
        </p>
        <ul class="held">
          {#each status.heldDeletions.paths as path (path)}<li>{path}</li>{/each}
        </ul>
        <span class="row">
          <button class="danger" onclick={() => run(() => daemon.resolveDeletions(true))}>Delete</button>
          <button class="primary" onclick={() => run(() => daemon.resolveDeletions(false))}>
            Restore from the other side
          </button>
        </span>
      {/if}
      {#if status.settings}
        <dl>
          <dt>Local</dt><dd>{status.settings.localRoot}</dd>
          <dt>Drive</dt><dd>{status.settings.remotePath}</dd>
        </dl>
      {/if}
      <span class="row">
        <button onclick={editSettings}>Change folders</button>
        <button onclick={() => run(daemon.logout)}>Sign out</button>
      </span>
    </section>

    <section class="card">
      <h2>Recent activity</h2>
      {#if activity.length === 0}
        <p class="hint">No operation since the service started.</p>
      {:else}
        <ul class="activity">
          {#each activity as item (item.time + item.path + item.action)}
            <li class:failed={item.error}>
              <time>{new Date(item.time).toLocaleTimeString()}</time>
              <span class="action">{item.action}</span>
              <span class="path" title={item.error ?? item.path}>{item.path}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if requestError}<p class="error">{requestError}</p>{/if}
</main>

<style>
  :root {
    --bg: #f5f5f4;
    --card: #ffffff;
    --text: #1c1917;
    --muted: #78716c;
    --border: #e7e5e4;
    --accent: #0f766e;
    --danger: #b91c1c;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1917;
      --card: #292524;
      --text: #f5f5f4;
      --muted: #a8a29e;
      --border: #44403c;
      --accent: #2dd4bf;
      --danger: #f87171;
    }
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
  }
  main {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  h1, h2 {
    margin: 0;
    font-size: 16px;
  }
  h2 { font-size: 14px; }
  p { margin: 0; }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--muted);
  }
  input {
    flex: 1;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
  }
  button {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--card);
    color: var(--text);
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  button.danger {
    border-color: var(--danger);
    color: var(--danger);
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .notice, .hint { color: var(--muted); }
  .error { color: var(--danger); }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
  }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--muted);
  }
  .dot.idle { background: var(--accent); }
  .dot.syncing, .dot.starting, .dot.awaitingApproval { background: #d97706; }
  .dot.error { background: var(--danger); }
  .progress {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .progress progress {
    flex: 1;
    accent-color: var(--accent);
  }
  .held {
    margin: 0;
    padding-left: 18px;
    max-height: 160px;
    overflow-y: auto;
    overflow-wrap: anywhere;
  }
  .activity {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
  }
  .activity li {
    display: grid;
    grid-template-columns: auto 9em 1fr;
    gap: 8px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
  }
  .activity time, .action { color: var(--muted); }
  .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .failed .path, .failed .action { color: var(--danger); }
</style>
