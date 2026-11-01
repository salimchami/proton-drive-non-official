import { stat } from "node:fs/promises";

import type { PlannedAction } from "./planner.ts";
import type { BaseEntry } from "./state.ts";

/** A plan trashing more files than this waits for the user's approval. */
export const DELETION_APPROVAL_THRESHOLD = 50;

const DELETIONS = new Set(["deleteLocal", "deleteRemote", "deleteLocalFolder", "deleteRemoteFolder"]);

export class LocalRootMissingError extends Error {
    constructor(readonly localRoot: string) {
        super(`Local folder not found: ${localRoot}`);
    }
}

/**
 * Throws when the synced local folder is not a directory: an unmounted disk or a renamed
 * folder would otherwise read as every file deleted locally.
 */
export async function assertLocalRoot(localRoot: string): Promise<void> {
    const stats = await stat(localRoot).catch(() => undefined);
    if (!stats?.isDirectory()) {
        throw new LocalRootMissingError(localRoot);
    }
}

/** The deletion actions of `actions` not in `approved`. */
export function unapprovedDeletions(actions: PlannedAction[], approved: ReadonlySet<string>): PlannedAction[] {
    return actions.filter(({ path, action }) => DELETIONS.has(action) && !approved.has(path));
}

/** Files trashed by `deletions`: a deleted folder counts the synced files under it. */
export function countDeletedFiles(deletions: PlannedAction[], base: ReadonlyMap<string, BaseEntry>): number {
    let count = 0;
    for (const { path, action } of deletions) {
        if (action === "deleteLocal" || action === "deleteRemote") {
            count++;
        } else {
            for (const entry of base.values()) {
                if (entry.type === "file" && entry.path.startsWith(`${path}/`)) {
                    count++;
                }
            }
        }
    }
    return count;
}
