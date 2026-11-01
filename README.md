# proton-drive-non-official

Unofficial third-party Proton Drive sync client for Linux. The package, binary and service are named `drive-sync`.

> **This is a third-party application not officially supported by Proton.**
> It is not affiliated with, endorsed by or maintained by Proton AG.

Keeps a local folder and a folder of Proton Drive's "My files" in two-way sync.
Built on Proton's [Drive SDK](https://github.com/ProtonDriveApps/sdk) (`@protontech/drive-sdk`).

Status: alpha.

## Features

- Two-way sync between one local folder and one Drive folder (or the whole of "My files").
- Sign-in through the browser on `account.proton.me`; the session is stored in the Secret Service
  (GNOME Keyring, KWallet) via `secret-tool`, never on disk in clear.
- Deletions go to the trash on both sides: Drive trash and desktop trash (`gio trash`).
- A plan trashing more than 50 files waits for approval in the UI.
- Desktop UI with tray icon (Tauri + SvelteKit) talking to the daemon over a per-user Unix socket.

## Layout

| Path        | Content                                                                 |
|-------------|-------------------------------------------------------------------------|
| `daemon/`   | Sync daemon (TypeScript, Node.js ≥ 22), bundled with esbuild            |
| `ui/`       | Desktop UI (Tauri 2, SvelteKit, Svelte 5)                               |
| `packaging/`| Debian scripts, systemd user unit, pinned Node.js runtime fetcher       |

## Build

Requirements: Node.js ≥ 22, Rust toolchain and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for Linux.

```sh
npm install
npm run check      # type-check daemon and UI
npm test -w daemon # daemon unit tests
npm run package    # builds the .deb
```

The `.deb` ships its own Node.js runtime (Ubuntu 24.04 only provides Node 18) and depends on
`libsecret-tools` and `libglib2.0-bin`. Installing it enables the `drive-sync` systemd user service
for every user, started at their next login.

## Usage

The UI handles sign-in and folder selection. The daemon bundle also takes CLI commands
(installed package: `/usr/lib/drive-sync/node /usr/lib/drive-sync/daemon/main.mjs`):

```sh
npm run build -w daemon
node daemon/dist/main.mjs          # daemon mode
node daemon/dist/main.mjs login    # sign in through the browser
node daemon/dist/main.mjs logout
node daemon/dist/main.mjs plan     # dry run: prints the planned actions, executes none
```

Set `DRIVE_SYNC_DEBUG=1` for debug logs.

| File                                           | Content                         |
|------------------------------------------------|---------------------------------|
| `$XDG_CONFIG_HOME/drive-sync/config.json`      | `localRoot` and `remotePath`    |
| `$XDG_DATA_HOME/drive-sync/state.db`           | Sync state                      |
| `$XDG_RUNTIME_DIR/drive-sync/daemon.sock`      | Daemon ↔ UI socket (mode 0600)  |

## License

[GPL-3.0-or-later](LICENSE).

`daemon/src/vendor/proton-account/` is copied from Proton's SDK repository under the MIT license,
see its [`LICENSE.md`](daemon/src/vendor/proton-account/LICENSE.md) and
[`UPSTREAM.md`](daemon/src/vendor/proton-account/UPSTREAM.md).
