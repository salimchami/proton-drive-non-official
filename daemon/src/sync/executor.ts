import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import type { ProtonDriveClient } from "@protontech/drive-sdk";
import mime from "mime";

import type { Logger } from "../vendor/proton-account/index.ts";
import { type LocalEntry, scanLocal, sha1File, TEMP_PREFIX } from "./localTree.ts";
import type { PlannedAction } from "./planner.ts";
import type { RemoteTree } from "./remoteTree.ts";
import type { StateDb } from "./state.ts";

type DriveApi = Pick<
    ProtonDriveClient,
    "getFileUploader" | "getFileRevisionUploader" | "getFileDownloader" | "trashNodes" | "createFolder"
>;

export interface ExecutionContext {
    localRoot: string;
    drive: DriveApi;
    state: StateDb;
    local: Map<string, LocalEntry>;
    remote: RemoteTree;
    logger: Logger;
    /** Called after each action, with the error when it failed. */
    onResult?: (action: PlannedAction["action"], relPath: string, error?: unknown) => void;
    onActionStart?: (relPath: string) => void;
    /** Bytes transferred since the last call; negative when the SDK retries a block. */
    onBytes?: (delta: number) => void;
}

/**
 * Applies planned actions in order. Nothing is ever deleted for good: removals go to the
 * Drive trash and to the desktop trash. A failed action is logged and left for the next
 * plan; the actions after it still run.
 */
export async function execute(ctx: ExecutionContext, actions: PlannedAction[]): Promise<void> {
    for (const { path: relPath, action } of actions) {
        ctx.onActionStart?.(relPath);
        try {
            await ACTIONS[action](ctx, relPath);
            ctx.logger.info(`${action} ${relPath}`);
            ctx.onResult?.(action, relPath);
        } catch (error) {
            ctx.logger.error(`${action} ${relPath} failed`, error);
            ctx.onResult?.(action, relPath, error);
        }
    }
}

const ACTIONS: Record<PlannedAction["action"], (ctx: ExecutionContext, relPath: string) => Promise<void>> = {
    none: async () => {},
    upload,
    download,
    deleteLocal: trashLocal,
    deleteLocalFolder: trashLocal,
    deleteRemote: trashRemote,
    deleteRemoteFolder: trashRemote,
    conflict: keepBothCopies,
    adoptBoth: adopt,
    adoptFolder: adopt,
    createLocalFolder: async (ctx, relPath) => {
        await mkdir(absolute(ctx, relPath), { recursive: true });
        await adopt(ctx, relPath);
    },
    createRemoteFolder: async (ctx, relPath) => {
        const node = await ctx.drive.createFolder(parentUid(ctx, relPath), path.posix.basename(relPath));
        ctx.remote.record({
            uid: node.uid,
            parentUid: parentUid(ctx, relPath),
            name: path.posix.basename(relPath),
            type: "folder",
        });
        await adopt(ctx, relPath);
    },
};

async function upload(ctx: ExecutionContext, relPath: string): Promise<void> {
    const absPath = absolute(ctx, relPath);
    const { size, mtime } = await stat(absPath);
    const sha1 = await sha1File(absPath);
    const metadata = {
        mediaType: mime.getType(relPath) ?? "application/octet-stream",
        expectedSize: size,
        // The SDK rejects the upload if the file changes while it is read.
        expectedSha1: sha1,
        modificationTime: mtime,
    };
    const existing = ctx.remote.entryAt(relPath);
    const uploader =
        existing?.type === "file"
            ? await ctx.drive.getFileRevisionUploader(existing.uid, metadata)
            : await ctx.drive.getFileUploader(parentUid(ctx, relPath), path.posix.basename(relPath), metadata);
    const controller = await uploader.uploadFromStream(
        Readable.toWeb(createReadStream(absPath)) as ReadableStream,
        [],
        ctx.onBytes,
    );
    const { nodeUid, nodeRevisionUid } = await controller.completion();

    ctx.remote.record({
        uid: nodeUid,
        parentUid: parentUid(ctx, relPath),
        name: path.posix.basename(relPath),
        type: "file",
        revisionUid: nodeRevisionUid,
        sha1,
        size,
    });
    await adopt(ctx, relPath);
}

async function download(ctx: ExecutionContext, relPath: string): Promise<void> {
    const remoteEntry = requireRemote(ctx, relPath);
    const absPath = absolute(ctx, relPath);
    const tempPath = path.join(path.dirname(absPath), `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
    await mkdir(path.dirname(absPath), { recursive: true });

    const downloader = await ctx.drive.getFileDownloader(remoteEntry.uid);
    const controller = downloader.downloadToStream(Writable.toWeb(createWriteStream(tempPath)), ctx.onBytes);
    try {
        // Throws on any verification failure, including signature issues: the file is not kept.
        await controller.completion();
        await assertLocalUnchanged(ctx, relPath);
        await rename(tempPath, absPath);
    } finally {
        await rm(tempPath, { force: true });
    }
    await adopt(ctx, relPath);
}

/** Moves a local file or folder to the desktop trash (`gio trash`, freedesktop.org Trash spec). */
async function trashLocal(ctx: ExecutionContext, relPath: string): Promise<void> {
    await assertLocalUnchanged(ctx, relPath);
    await run("gio", ["trash", "--", absolute(ctx, relPath)]);
    for (const known of [...ctx.local.keys()]) {
        if (known === relPath || known.startsWith(`${relPath}/`)) {
            ctx.local.delete(known);
        }
    }
    forgetBase(ctx, relPath);
}

async function trashRemote(ctx: ExecutionContext, relPath: string): Promise<void> {
    const remoteEntry = requireRemote(ctx, relPath);
    for await (const result of ctx.drive.trashNodes([remoteEntry.uid])) {
        if (!result.ok) {
            throw result.error;
        }
    }
    ctx.remote.forget(remoteEntry.uid);
    forgetBase(ctx, relPath);
}

/**
 * Renames the local copy to "name (conflict host date).ext"; the next plans then download
 * the Drive version to the original path and upload the renamed copy.
 */
async function keepBothCopies(ctx: ExecutionContext, relPath: string): Promise<void> {
    const { dir, name, ext } = path.posix.parse(relPath);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const copyPath = path.posix.join(dir, `${name} (conflict ${hostname()} ${stamp})${ext}`);
    await rename(absolute(ctx, relPath), absolute(ctx, copyPath));
    for (const [known, entry] of [...ctx.local]) {
        if (known === relPath || known.startsWith(`${relPath}/`)) {
            ctx.local.delete(known);
            ctx.local.set(copyPath + known.slice(relPath.length), entry);
        }
    }
}

/** Records the current state of both sides as the new base for the path. */
async function adopt(ctx: ExecutionContext, relPath: string): Promise<void> {
    const scanned = (await scanLocal(ctx.localRoot, ctx.state.allEntries(), [relPath])).get(relPath);
    const remoteEntry = ctx.remote.entryAt(relPath);
    if (!scanned || !remoteEntry) {
        forgetBase(ctx, relPath);
        return;
    }
    ctx.local.set(relPath, scanned);
    ctx.state.putEntry({
        path: relPath,
        type: remoteEntry.type,
        remoteUid: remoteEntry.uid,
        ...(scanned.sha1 !== undefined && { sha1: scanned.sha1 }),
        ...(scanned.size !== undefined && { size: scanned.size }),
        ...(scanned.mtimeMs !== undefined && { localMtimeMs: scanned.mtimeMs }),
        ...(remoteEntry.revisionUid !== undefined && { remoteRevisionUid: remoteEntry.revisionUid }),
    });
}

function forgetBase(ctx: ExecutionContext, relPath: string): void {
    for (const known of ctx.state.allEntries().keys()) {
        if (known === relPath || known.startsWith(`${relPath}/`)) {
            ctx.state.deleteEntry(known);
        }
    }
}

/** Refuses to overwrite or trash a local file created or edited after the plan was made. */
async function assertLocalUnchanged(ctx: ExecutionContext, relPath: string): Promise<void> {
    const planned = ctx.local.get(relPath);
    if (planned?.type === "folder") {
        return;
    }
    const current = (await scanLocal(ctx.localRoot, ctx.state.allEntries(), [relPath])).get(relPath);
    if (current?.type !== planned?.type || current?.sha1 !== planned?.sha1) {
        throw new Error("the local file changed since the plan; it will be re-planned");
    }
}

function requireRemote(ctx: ExecutionContext, relPath: string) {
    const entry = ctx.remote.entryAt(relPath);
    if (!entry) {
        throw new Error("no longer on Drive");
    }
    return entry;
}

function parentUid(ctx: ExecutionContext, relPath: string): string {
    const parentPath = path.posix.dirname(relPath);
    if (parentPath === ".") {
        return ctx.remote.rootUid;
    }
    const parent = ctx.remote.entryAt(parentPath);
    if (parent?.type !== "folder") {
        throw new Error(`parent folder ${parentPath} is not on Drive yet`);
    }
    return parent.uid;
}

function absolute(ctx: ExecutionContext, relPath: string): string {
    return path.join(ctx.localRoot, ...relPath.split("/"));
}

function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`)),
        );
    });
}
