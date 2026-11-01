import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { watchCodeUpdates } from "./update.ts";

test("replacing the bundle the way dpkg does reports the daemon as outdated", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "drive-sync-update-"));
    const codePath = path.join(dir, "main.mjs");
    const shutdown = new AbortController();
    try {
        await writeFile(codePath, "old");
        const { promise: outdated, resolve } = Promise.withResolvers<void>();
        await watchCodeUpdates(codePath, resolve, shutdown.signal);
        await writeFile(`${codePath}.dpkg-new`, "new");
        await rename(`${codePath}.dpkg-new`, codePath);
        await outdated;
    } finally {
        shutdown.abort();
        await rm(dir, { recursive: true });
    }
});

test("rewriting the bundle with the same content is not an update", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "drive-sync-update-"));
    const codePath = path.join(dir, "main.mjs");
    const shutdown = new AbortController();
    try {
        await writeFile(codePath, "same");
        let outdated = false;
        await watchCodeUpdates(codePath, () => (outdated = true), shutdown.signal);
        await writeFile(codePath, "same");
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal(outdated, false);
    } finally {
        shutdown.abort();
        await rm(dir, { recursive: true });
    }
});
