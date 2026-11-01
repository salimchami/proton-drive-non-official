import assert from "node:assert/strict";
import { test } from "node:test";

import type { LocalEntry } from "./localTree.ts";
import { fileState, plan, type Snapshot } from "./planner.ts";
import type { RemoteEntry } from "./remoteTree.ts";
import type { BaseEntry } from "./state.ts";

const baseFile = (path: string, sha1: string, rev: string): [string, BaseEntry] => [
    path,
    { path, type: "file", remoteUid: `uid-${path}`, sha1, remoteRevisionUid: rev },
];
const baseFolder = (path: string): [string, BaseEntry] => [path, { path, type: "folder", remoteUid: `uid-${path}` }];
const localFile = (path: string, sha1: string): [string, LocalEntry] => [path, { type: "file", sha1 }];
const localFolder = (path: string): [string, LocalEntry] => [path, { type: "folder" }];
const remoteFile = (path: string, sha1: string | undefined, rev: string): [string, RemoteEntry] => [
    path,
    {
        uid: `uid-${path}`,
        parentUid: "p",
        name: path,
        type: "file",
        revisionUid: rev,
        ...(sha1 !== undefined && { sha1 }),
    },
];
const remoteFolder = (path: string): [string, RemoteEntry] => [
    path,
    { uid: `uid-${path}`, parentUid: "p", name: path, type: "folder" },
];

const snapshot = (base: [string, BaseEntry][], local: [string, LocalEntry][], remote: [string, RemoteEntry][]): Snapshot => ({
    base: new Map(base),
    local: new Map(local),
    remote: new Map(remote),
});

test("fileState detects a local edit by SHA-1 and a remote edit by revision", () => {
    const s = snapshot([baseFile("a", "s1", "r1")], [localFile("a", "s2")], [remoteFile("a", "s1", "r2")]);

    assert.deepEqual(fileState(s, "a"), { inBase: true, local: "changed", remote: "changed", sameContent: false });
});

test("fileState treats a missing remote SHA-1 as unknown content", () => {
    const s = snapshot([], [localFile("a", "s1")], [remoteFile("a", undefined, "r1")]);

    assert.deepEqual(fileState(s, "a"), { inBase: false, local: "changed", remote: "changed", sameContent: false });
});

test("a local edit is uploaded", () => {
    const s = snapshot([baseFile("a", "s1", "r1")], [localFile("a", "s2")], [remoteFile("a", "s1", "r1")]);

    assert.deepEqual(plan(s, [""]), [{ path: "a", action: "upload" }]);
});

test("a remote edit is downloaded", () => {
    const s = snapshot([baseFile("a", "s1", "r1")], [localFile("a", "s1")], [remoteFile("a", "s2", "r2")]);

    assert.deepEqual(plan(s, [""]), [{ path: "a", action: "download" }]);
});

test("a remote-only folder is created locally before its files are downloaded", () => {
    const s = snapshot([], [], [remoteFolder("d"), remoteFile("d/a", "s1", "r1")]);

    assert.deepEqual(plan(s, [""]), [
        { path: "d", action: "createLocalFolder" },
        { path: "d/a", action: "download" },
    ]);
});

test("a folder deleted locally is trashed remotely as a whole when nothing in it changed", () => {
    const s = snapshot(
        [baseFolder("d"), baseFile("d/a", "s1", "r1")],
        [],
        [remoteFolder("d"), remoteFile("d/a", "s1", "r1")],
    );

    assert.deepEqual(plan(s, ["d"]), [{ path: "d", action: "deleteRemoteFolder" }]);
});

test("a file and a folder at the same path are a conflict", () => {
    const s = snapshot([], [localFile("x", "s1")], [remoteFolder("x")]);

    assert.deepEqual(plan(s, [""]), [{ path: "x", action: "conflict" }]);
});

test("unchanged paths and paths outside the scope produce nothing", () => {
    const s = snapshot(
        [baseFile("a", "s1", "r1"), baseFile("b", "s1", "r1")],
        [localFile("a", "s1"), localFile("b", "s2")],
        [remoteFile("a", "s1", "r1"), remoteFile("b", "s1", "r1")],
    );

    assert.deepEqual(plan(s, ["a"]), []);
});
