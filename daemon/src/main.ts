// Node 22 lacks Uint8Array.prototype.toHex, used by the crypto package (see its README).
import "@protontech/crypto/polyfill";

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appDir, THIRD_PARTY_NOTICE } from "./config.ts";
import { initDrive } from "./drive/client.ts";
import { loadSettings } from "./settings.ts";
import { serveIpc } from "./ipc/server.ts";
import { DaemonService } from "./service.ts";
import { SyncEngine } from "./sync/engine.ts";
import { StateDb } from "./sync/state.ts";
import { watchCodeUpdates } from "./update.ts";
import type { Logger } from "./vendor/proton-account/index.ts";

const verbose = process.env.DRIVE_SYNC_DEBUG === "1";
const logger: Logger = {
    debug: (message, ...args) => verbose && console.debug(message, ...args),
    info: (message, ...args) => console.info(message, ...args),
    warn: (message, ...args) => console.warn(message, ...args),
    error: (message, ...args) => console.error(message, ...args),
};

// The process stays alive through its open handles (IPC server, watcher, event polling);
// the signal handlers only close them.
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => shutdown.abort());
}

const { auth, createSdk } = await initDrive(logger);

async function openState(): Promise<StateDb> {
    await mkdir(appDir(), { recursive: true });
    const state = new StateDb(path.join(appDir(), "state.db"));
    shutdown.signal.addEventListener("abort", () => state.close());
    return state;
}

switch (process.argv[2]) {
    case undefined: {
        // Daemon mode: serves the UI over the IPC socket and syncs once signed in and configured.
        const service = new DaemonService(auth, createSdk, await openState(), logger);
        await serveIpc(service, logger, shutdown.signal);
        shutdown.signal.addEventListener("abort", () => service.stop());
        await watchCodeUpdates(fileURLToPath(import.meta.url), () => service.markOutdated(), shutdown.signal);
        await service.start();
        break;
    }
    case "login": {
        console.log(THIRD_PARTY_NOTICE);
        await auth.authViaWeb((signInUrl) => {
            spawn("xdg-open", [signInUrl], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
            console.log(`Sign in from your browser (opened automatically, or open this URL):\n${signInUrl}`);
        }, shutdown.signal);
        console.log("Signed in");
        break;
    }
    case "logout":
        await auth.logout();
        console.log("Signed out");
        break;
    case "plan": {
        // Dry run: keeps the three views current and prints the planned actions, executing none.
        const settings = await loadSettings();
        if (!auth.isLoggedIn() || !settings) {
            console.error("Sign in (`drive-sync login`) and configure the synced folders first");
            process.exitCode = 1;
            break;
        }
        const engine = new SyncEngine(createSdk(), settings, await openState(), logger, {
            dryRun: true,
            onPlan: (actions) => {
                for (const { action, path: relPath } of actions) {
                    console.log(`[plan] ${action.padEnd(18)} ${relPath}`);
                }
            },
        });
        await engine.start(shutdown.signal);
        break;
    }
    default:
        console.error("Usage: drive-sync [login | logout | plan]");
        process.exitCode = 1;
}
