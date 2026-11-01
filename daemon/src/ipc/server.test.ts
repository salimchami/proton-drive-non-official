import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { DaemonService } from "../service.ts";
import type { Logger } from "../vendor/proton-account/index.ts";
import { serveIpc, socketPath } from "./server.ts";

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test("shutdown closes the connections still open, so the process can exit", async () => {
    const runtimeDir = await mkdtemp(path.join(tmpdir(), "ds-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    const shutdown = new AbortController();
    try {
        const service = { subscribe: () => () => {} } as unknown as DaemonService;
        await serveIpc(service, silent, shutdown.signal);
        const client = connect(socketPath());
        await new Promise((resolve) => client.once("connect", resolve));
        const closed = new Promise((resolve) => client.once("close", resolve));

        shutdown.abort();
        await closed;
        assert.ok(client.destroyed);
    } finally {
        shutdown.abort();
        if (previous === undefined) {
            delete process.env.XDG_RUNTIME_DIR;
        } else {
            process.env.XDG_RUNTIME_DIR = previous;
        }
        await rm(runtimeDir, { recursive: true });
    }
});
