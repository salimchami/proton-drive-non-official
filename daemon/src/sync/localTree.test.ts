import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { scanLocal, TEMP_PREFIX } from "./localTree.ts";
import type { BaseEntry } from "./state.ts";

const SHA1_HELLO = "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "drive-sync-test-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("scans files and folders with relative posix paths and SHA-1", async () => {
    await mkdir(path.join(root, "docs/sub"), { recursive: true });
    await writeFile(path.join(root, "docs/sub/a.txt"), "hello");

    const scanned = await scanLocal(root, new Map());

    assert.deepEqual([...scanned.keys()].sort(), ["docs", "docs/sub", "docs/sub/a.txt"]);
    assert.equal(scanned.get("docs/sub/a.txt")?.sha1, SHA1_HELLO);
    assert.equal(scanned.get("docs")?.type, "folder");
});

test("skips temporary download files and symlinks", async () => {
    await writeFile(path.join(root, `${TEMP_PREFIX}partial`), "x");
    await writeFile(path.join(root, "real.txt"), "x");
    await symlink(path.join(root, "real.txt"), path.join(root, "link"));

    const scanned = await scanLocal(root, new Map());

    assert.deepEqual([...scanned.keys()].sort(), ["link", "real.txt"]);
    assert.equal(scanned.get("link"), undefined);
});

test("reuses the base SHA-1 when size and mtime are unchanged", async () => {
    await writeFile(path.join(root, "a.txt"), "hello");
    const { size, mtimeMs } = await stat(path.join(root, "a.txt"));
    const base = new Map<string, BaseEntry>([
        ["a.txt", { path: "a.txt", type: "file", remoteUid: "r", sha1: "from-base", size, localMtimeMs: mtimeMs }],
    ]);

    const scanned = await scanLocal(root, base);

    assert.equal(scanned.get("a.txt")?.sha1, "from-base");
});

test("reports a vanished path as undefined", async () => {
    const scanned = await scanLocal(root, new Map(), ["gone/file.txt"]);

    assert.deepEqual([...scanned], [["gone/file.txt", undefined]]);
});
