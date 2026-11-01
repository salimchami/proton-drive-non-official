import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertLocalRoot, countDeletedFiles, LocalRootMissingError, unapprovedDeletions } from "./guard.ts";
import type { BaseEntry } from "./state.ts";

const entry = (path: string, type: BaseEntry["type"]): [string, BaseEntry] => [path, { path, type, remoteUid: path }];

test("a deleted folder counts the synced files under it, not itself", () => {
    const base = new Map([
        entry("docs", "folder"),
        entry("docs/a.txt", "file"),
        entry("docs/sub", "folder"),
        entry("docs/sub/b.txt", "file"),
        entry("docsx.txt", "file"),
    ]);
    const count = countDeletedFiles(
        [
            { path: "docs", action: "deleteRemoteFolder" },
            { path: "docsx.txt", action: "deleteLocal" },
        ],
        base,
    );
    assert.equal(count, 3);
});

test("only deletions outside the approved paths are kept", () => {
    const deletions = unapprovedDeletions(
        [
            { path: "a", action: "deleteRemote" },
            { path: "b", action: "upload" },
            { path: "c", action: "deleteLocalFolder" },
        ],
        new Set(["a"]),
    );
    assert.deepEqual(deletions, [{ path: "c", action: "deleteLocalFolder" }]);
});

test("the local root must be an existing directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "drive-sync-guard-"));
    try {
        await assertLocalRoot(dir);
        await writeFile(path.join(dir, "file"), "");
        await assert.rejects(assertLocalRoot(path.join(dir, "file")), LocalRootMissingError);
        await assert.rejects(assertLocalRoot(path.join(dir, "missing")), LocalRootMissingError);
    } finally {
        await rm(dir, { recursive: true });
    }
});
