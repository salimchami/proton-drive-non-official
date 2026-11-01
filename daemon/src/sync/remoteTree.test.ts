import assert from "node:assert/strict";
import { test } from "node:test";

import { DriveEventType, NodeType } from "@protontech/drive-sdk";

import { RemoteTree } from "./remoteTree.ts";
import { StateDb } from "./state.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const folder = (uid: string, parentUid: string, name: string) => ({
    uid,
    parentUid,
    name: { ok: true, value: name },
    type: NodeType.Folder,
});
const file = (uid: string, parentUid: string, name: string, revision: string) => ({
    uid,
    parentUid,
    name: { ok: true, value: name },
    type: NodeType.File,
    activeRevision: { uid: revision, claimedDigests: { sha1: `sha-${revision}` }, claimedSize: 3 },
});

/** Fake Drive listing a fixed tree; `failOn` makes the listing of that folder throw. */
function fakeDrive(children: Record<string, object[]>, failOn?: string) {
    return {
        async *iterateFolderChildren(folderUid: string) {
            if (folderUid === failOn) {
                throw new Error("listing interrupted");
            }
            yield* children[folderUid] ?? [];
        },
        getNode: async () => {
            throw new Error("not used");
        },
    } as never;
}

const tree = {
    root: [folder("docs", "root", "docs"), file("a", "root", "a.txt", "r1")],
    docs: [file("b", "docs", "b.txt", "r2")],
};

test("a completed listing is restored by the next start without listing again", async () => {
    const state = new StateDb(":memory:");
    await new RemoteTree(fakeDrive(tree), "root", state, silent).loadAll();

    const restarted = new RemoteTree(fakeDrive({}, "root"), "root", state, silent);
    assert.equal(restarted.restore(), true);
    assert.deepEqual([...restarted.snapshot().keys()].sort(), ["a.txt", "docs", "docs/b.txt"]);
    assert.equal(restarted.snapshot().get("docs/b.txt")?.revisionUid, "r2");
    state.close();
});

test("an interrupted listing is not restored", async () => {
    const state = new StateDb(":memory:");
    await assert.rejects(new RemoteTree(fakeDrive(tree, "docs"), "root", state, silent).loadAll());

    assert.equal(new RemoteTree(fakeDrive({}), "root", state, silent).restore(), false);
    state.close();
});

test("the mirror of another root folder is not restored", async () => {
    const state = new StateDb(":memory:");
    await new RemoteTree(fakeDrive(tree), "root", state, silent).loadAll();

    assert.equal(new RemoteTree(fakeDrive({}), "other-root", state, silent).restore(), false);
    state.close();
});

test("changes applied from events are persisted", async () => {
    const state = new StateDb(":memory:");
    const remote = new RemoteTree(fakeDrive(tree), "root", state, silent);
    await remote.loadAll();
    await remote.applyEvent({ type: DriveEventType.NodeDeleted, nodeUid: "docs" } as never);

    const restarted = new RemoteTree(fakeDrive({}), "root", state, silent);
    restarted.restore();
    assert.deepEqual([...restarted.snapshot().keys()], ["a.txt"]);
    state.close();
});

test("folders are listed concurrently, within the limit, and all of them", async () => {
    const children: Record<string, object[]> = { root: [] };
    for (let i = 0; i < 30; i++) {
        children.root!.push(folder(`f${i}`, "root", `f${i}`));
        children[`f${i}`] = [file(`x${i}`, `f${i}`, "x.txt", `r${i}`)];
    }
    let running = 0;
    let peak = 0;
    const drive = {
        async *iterateFolderChildren(folderUid: string) {
            running++;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 5));
            running--;
            yield* children[folderUid] ?? [];
        },
    } as never;
    const state = new StateDb(":memory:");
    const remote = new RemoteTree(drive, "root", state, silent);
    await remote.loadAll();

    assert.equal(remote.snapshot().size, 60);
    assert.ok(peak > 1 && peak <= 8, `peak concurrency ${peak}`);
    state.close();
});

test("nodes whose name would resolve outside their folder are skipped", async () => {
    const state = new StateDb(":memory:");
    const remote = new RemoteTree(
        fakeDrive({
            root: [
                file("up", "root", "..", "r1"),
                file("dot", "root", ".", "r2"),
                file("empty", "root", "", "r3"),
                file("slash", "root", "a/b", "r4"),
                file("nul", "root", "a\0b", "r5"),
                file("temp", "root", ".drive-sync-x", "r6"),
                folder("evil", "root", ".."),
                file("ok", "root", "ok.txt", "r7"),
            ],
            evil: [file("child", "evil", "passwd", "r8")],
        }),
        "root",
        state,
        silent,
    );
    await remote.loadAll();

    assert.deepEqual([...remote.snapshot().keys()], ["ok.txt"]);
    state.close();
});
