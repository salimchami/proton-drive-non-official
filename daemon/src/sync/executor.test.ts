import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { type ExecutionContext, execute } from "./executor.ts";
import { RemoteTree } from "./remoteTree.ts";
import { StateDb } from "./state.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Fake Drive: records uploads, serves one file's content, trashes by UID. */
function fakeDrive(content: Record<string, string> = {}) {
    const calls: string[] = [];
    let counter = 0;
    const uploader = (label: string) => ({
        uploadFromStream: async (stream: ReadableStream) => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of stream) chunks.push(chunk as Uint8Array);
            calls.push(`${label}:${Buffer.concat(chunks).toString()}`);
            counter++;
            return { pause() {}, resume() {}, completion: async () => ({ nodeUid: `n${counter}`, nodeRevisionUid: `r${counter}` }) };
        },
    });
    const drive = {
        getFileUploader: async (parentUid: string, name: string) => uploader(`upload ${parentUid}/${name}`),
        getFileRevisionUploader: async (uid: string) => uploader(`revision ${uid}`),
        getFileDownloader: async (uid: string) => ({
            downloadToStream: (stream: WritableStream) => ({
                completion: async () => {
                    const writer = stream.getWriter();
                    await writer.write(new TextEncoder().encode(content[uid] ?? ""));
                    await writer.close();
                },
            }),
        }),
        async *trashNodes(uids: string[]) {
            calls.push(`trash ${uids.join(",")}`);
            for (const uid of uids) yield { uid, ok: true as const };
        },
        createFolder: async (parentUid: string, name: string) => {
            calls.push(`mkdir ${parentUid}/${name}`);
            return { uid: `folder-${name}` };
        },
    };
    return { drive: drive as unknown as ExecutionContext["drive"], calls };
}

let root: string;
let state: StateDb;

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "drive-sync-exec-"));
    state = new StateDb(":memory:");
});

afterEach(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
});

function context(drive: ExecutionContext["drive"]): ExecutionContext {
    const remote = new RemoteTree({} as never, "root", state, silent);
    return { localRoot: root, drive, state, local: new Map(), remote, logger: silent };
}

test("upload creates the file in the right parent and records the base", async () => {
    await writeFile(path.join(root, "a.txt"), "hello");
    const { drive, calls } = fakeDrive();
    const ctx = context(drive);

    await execute(ctx, [{ path: "a.txt", action: "upload" }]);

    assert.deepEqual(calls, ["upload root/a.txt:hello"]);
    assert.equal(ctx.remote.entryAt("a.txt")?.revisionUid, "r1");
    assert.equal(state.allEntries().get("a.txt")?.remoteRevisionUid, "r1");
});

test("upload of a known file creates a new revision", async () => {
    await writeFile(path.join(root, "a.txt"), "v2");
    const { drive, calls } = fakeDrive();
    const ctx = context(drive);
    ctx.remote.record({ uid: "f1", parentUid: "root", name: "a.txt", type: "file", revisionUid: "r0" });

    await execute(ctx, [{ path: "a.txt", action: "upload" }]);

    assert.deepEqual(calls, ["revision f1:v2"]);
});

test("download writes the file atomically and records the base", async () => {
    const { drive } = fakeDrive({ f1: "remote content" });
    const ctx = context(drive);
    ctx.remote.record({ uid: "f1", parentUid: "root", name: "b.txt", type: "file", revisionUid: "r1" });

    await execute(ctx, [{ path: "b.txt", action: "download" }]);

    assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "remote content");
    assert.equal(state.allEntries().get("b.txt")?.remoteRevisionUid, "r1");
});

test("download refuses to overwrite a local file created after the plan", async () => {
    const { drive } = fakeDrive({ f1: "remote content" });
    const ctx = context(drive);
    ctx.remote.record({ uid: "f1", parentUid: "root", name: "b.txt", type: "file", revisionUid: "r1" });
    await writeFile(path.join(root, "b.txt"), "local edit");

    await execute(ctx, [{ path: "b.txt", action: "download" }]);

    assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "local edit");
    assert.equal(state.allEntries().size, 0);
});

test("deleteRemote trashes the node and forgets the base", async () => {
    const { drive, calls } = fakeDrive();
    const ctx = context(drive);
    ctx.remote.record({ uid: "f1", parentUid: "root", name: "c.txt", type: "file", revisionUid: "r1" });
    state.putEntry({ path: "c.txt", type: "file", remoteUid: "f1", sha1: "x", remoteRevisionUid: "r1" });

    await execute(ctx, [{ path: "c.txt", action: "deleteRemote" }]);

    assert.deepEqual(calls, ["trash f1"]);
    assert.equal(ctx.remote.entryAt("c.txt"), undefined);
    assert.equal(state.allEntries().size, 0);
});

test("createRemoteFolder then upload places the file inside the new folder", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(path.join(root, "d")));
    await writeFile(path.join(root, "d/e.txt"), "x");
    const { drive, calls } = fakeDrive();
    const ctx = context(drive);

    await execute(ctx, [
        { path: "d", action: "createRemoteFolder" },
        { path: "d/e.txt", action: "upload" },
    ]);

    assert.deepEqual(calls, ["mkdir root/d", "upload folder-d/e.txt:x"]);
});
