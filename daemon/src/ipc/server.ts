import { chmod, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";

import type { DaemonService } from "../service.ts";
import type { Logger } from "../vendor/proton-account/index.ts";
import type { Request, Response } from "./protocol.ts";

/** `$XDG_RUNTIME_DIR/drive-sync/daemon.sock`: per-user, tmpfs, removed at logout. */
export function socketPath(): string {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (!runtimeDir) {
        throw new Error("XDG_RUNTIME_DIR is not set: the daemon must run in a user session");
    }
    return path.join(runtimeDir, "drive-sync", "daemon.sock");
}

/**
 * Serves the UI protocol until `signal` aborts; only the owning user can connect (directory 0700,
 * socket 0600).
 */
export async function serveIpc(service: DaemonService, logger: Logger, signal: AbortSignal): Promise<void> {
    const file = socketPath();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if (await isListening(file)) {
        throw new Error(`Another drive-sync daemon is already running (${file})`);
    }
    await rm(file, { force: true });

    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        handleConnection(socket, service, logger);
    });
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(file, resolve));
    await chmod(file, 0o600);
    signal.addEventListener("abort", () => {
        // close() only stops accepting: the UI keeps its connection open, which would keep the process alive.
        server.close();
        for (const socket of sockets) {
            socket.destroy();
        }
    });
}

function handleConnection(socket: Socket, service: DaemonService, logger: Logger): void {
    const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
    const unsubscribe = service.subscribe(send);
    socket.on("close", unsubscribe);
    socket.on("error", (error) => logger.debug("IPC connection error", error));

    createInterface({ input: socket }).on("line", (line) => {
        let request: Request;
        try {
            request = JSON.parse(line) as Request;
        } catch {
            return;
        }
        dispatch(service, request).then(
            (result) => send({ id: request.id, ok: true, result } satisfies Response),
            (error: unknown) =>
                send({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies Response),
        );
    });
}

async function dispatch(service: DaemonService, request: Request): Promise<unknown> {
    switch (request.method) {
        case "status":
            return service.getStatus();
        case "recentActivity":
            return service.recentActivity();
        case "login":
            return service.login();
        case "logout":
            return service.logout();
        case "setSettings":
            return service.setSettings(request.settings);
        case "resolveDeletions":
            return service.resolveDeletions(request.approve);
        case "outdated":
            return service.isOutdated();
        default:
            throw new Error(`Unknown method ${(request as { method: string }).method}`);
    }
}

function isListening(file: string): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = connect(file)
            .once("connect", () => {
                probe.end();
                resolve(true);
            })
            .once("error", () => resolve(false));
    });
}
