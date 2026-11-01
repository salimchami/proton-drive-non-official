import { createHash } from "node:crypto";
import { createReadStream, watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import type { BaseEntry, EntryType } from "./state.ts";

/** Prefix of the files the daemon writes while downloading; they are never synced. */
export const TEMP_PREFIX = ".drive-sync-";

export interface LocalEntry {
    type: EntryType;
    /** Files only. */
    size?: number;
    mtimeMs?: number;
    sha1?: string;
}

/**
 * Reads the local state of `relPaths` (or of the whole tree when omitted) under `root`.
 * Directories are descended; a path that no longer exists maps to undefined.
 * A file's SHA-1 is reused from base when size and mtime did not change.
 */
export async function scanLocal(
    root: string,
    base: ReadonlyMap<string, BaseEntry>,
    relPaths: Iterable<string> = [""],
): Promise<Map<string, LocalEntry | undefined>> {
    const result = new Map<string, LocalEntry | undefined>();

    const visit = async (relPath: string): Promise<void> => {
        if (path.posix.basename(relPath).startsWith(TEMP_PREFIX)) {
            return;
        }
        const absPath = path.join(root, relPath);
        const stats = await lstat(absPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
                return undefined;
            }
            throw error;
        });
        if (!stats || !(stats.isFile() || stats.isDirectory())) {
            // Missing, or a symlink / special file: not synced.
            if (relPath !== "") {
                result.set(relPath, undefined);
            }
            return;
        }
        if (stats.isDirectory()) {
            if (relPath !== "") {
                result.set(relPath, { type: "folder" });
            }
            for (const name of await readdir(absPath)) {
                await visit(relPath === "" ? name : `${relPath}/${name}`);
            }
            return;
        }
        const known = base.get(relPath);
        const sha1 =
            known?.type === "file" && known.size === stats.size && known.localMtimeMs === stats.mtimeMs && known.sha1
                ? known.sha1
                : await sha1File(absPath);
        result.set(relPath, { type: "file", size: stats.size, mtimeMs: stats.mtimeMs, sha1 });
    };

    for (const relPath of relPaths) {
        await visit(relPath);
    }
    return result;
}

export function sha1File(absPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha1");
        createReadStream(absPath)
            .on("data", (chunk) => hash.update(chunk))
            .on("error", reject)
            .on("end", () => resolve(hash.digest("hex")));
    });
}

/** Reports the relative paths touched under `root`. Node's recursive watcher also covers new subdirectories. */
export function watchLocal(root: string, onPath: (relPath: string) => void): FSWatcher {
    return watch(root, { recursive: true }, (_event, filename) => {
        if (filename) {
            onPath(filename.split(path.sep).join("/"));
        }
    });
}
