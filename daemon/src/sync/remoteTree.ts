import { type DriveEvent, DriveEventType, type NodeEntity, NodeType, type ProtonDriveClient } from "@protontech/drive-sdk";

import type { Logger } from "../vendor/proton-account/index.ts";
import { TEMP_PREFIX } from "./localTree.ts";
import type { EntryType, StateDb } from "./state.ts";

export interface RemoteEntry {
    uid: string;
    parentUid: string;
    name: string;
    type: EntryType;
    /** Files only. */
    revisionUid?: string;
    /** Claimed by the uploader, may be missing on files uploaded by old clients. */
    sha1?: string;
    size?: number;
}

/** Folders listed at once: a sequential listing pays two round trips per folder. The SDK retries on 429. */
const LISTING_CONCURRENCY = 8;

type DriveApi = Pick<ProtonDriveClient, "iterateFolderChildren" | "getNode">;

export type RemoteTreeStore = Pick<
    StateDb,
    | "remoteNodes"
    | "putRemoteNode"
    | "deleteRemoteNode"
    | "clearRemoteNodes"
    | "completeRemoteTreeRoot"
    | "setCompleteRemoteTreeRoot"
>;

/** Mirror of the synced Drive folder, kept current from Drive events and written through to `store`. */
export class RemoteTree {
    private readonly nodes = new Map<string, RemoteEntry>();
    private readonly children = new Map<string, Set<string>>();

    constructor(
        private readonly drive: DriveApi,
        readonly rootUid: string,
        private readonly store: RemoteTreeStore,
        private readonly logger: Logger,
        /** Called after each folder listed, to report listing progress. */
        private readonly onFolderListed?: () => void,
    ) {}

    /** Loads the stored mirror; false when none was completed for this root folder. */
    restore(): boolean {
        if (this.store.completeRemoteTreeRoot() !== this.rootUid) {
            return false;
        }
        this.nodes.clear();
        this.children.clear();
        for (const entry of this.store.remoteNodes()) {
            this.addNode(entry);
        }
        return true;
    }

    /** Entry at a path relative to the root folder. */
    entryAt(relPath: string): RemoteEntry | undefined {
        let entry: RemoteEntry | undefined;
        let parentUid = this.rootUid;
        for (const name of relPath.split("/")) {
            entry = undefined;
            for (const childUid of this.children.get(parentUid) ?? []) {
                const child = this.nodes.get(childUid);
                if (child?.name === name) {
                    entry = child;
                    break;
                }
            }
            if (!entry) {
                return undefined;
            }
            parentUid = entry.uid;
        }
        return entry;
    }

    /** Records a change the daemon made itself, before its Drive event arrives. */
    record(entry: RemoteEntry): void {
        const previous = this.nodes.get(entry.uid);
        if (previous) {
            this.children.get(previous.parentUid)?.delete(entry.uid);
        }
        this.setNode(entry);
    }

    /** Forgets a node the daemon trashed itself, with its descendants. */
    forget(uid: string): void {
        this.removeSubtree(uid, new Set());
    }

    /** Full listing; done once at start-up and on TreeRefresh events only, as the SDK guidelines require. */
    async loadAll(signal?: AbortSignal): Promise<void> {
        this.nodes.clear();
        this.children.clear();
        this.store.clearRemoteNodes();
        await this.loadSubtree(this.rootUid, signal);
        // Marked only once complete: an interrupted listing is never restored as the whole tree.
        this.store.setCompleteRemoteTreeRoot(this.rootUid);
    }

    snapshot(): Map<string, RemoteEntry> {
        const result = new Map<string, RemoteEntry>();
        for (const entry of this.nodes.values()) {
            const entryPath = this.pathOf(entry.uid);
            if (entryPath !== undefined) {
                result.set(entryPath, entry);
            }
        }
        return result;
    }

    /** Path relative to the root folder, or undefined when the node is not (or no longer) under it. */
    pathOf(uid: string): string | undefined {
        const names: string[] = [];
        for (let entry = this.nodes.get(uid); entry; entry = this.nodes.get(entry.parentUid)) {
            names.unshift(entry.name);
            if (entry.parentUid === this.rootUid) {
                return names.join("/");
            }
        }
        return undefined;
    }

    /**
     * Applies one Drive event and returns the paths whose remote state may have changed,
     * including every descendant of a renamed, moved or removed folder.
     */
    async applyEvent(event: DriveEvent, signal?: AbortSignal): Promise<Set<string>> {
        const affected = new Set<string>();
        switch (event.type) {
            case DriveEventType.TreeRefresh: {
                this.collectSubtreePaths(this.rootUid, affected);
                await this.loadAll(signal);
                this.collectSubtreePaths(this.rootUid, affected);
                break;
            }
            case DriveEventType.NodeDeleted:
                this.removeSubtree(event.nodeUid, affected);
                break;
            case DriveEventType.NodeCreated:
            case DriveEventType.NodeUpdated: {
                const isKnownParent = event.parentNodeUid === this.rootUid || this.nodes.has(event.parentNodeUid ?? "");
                if (!this.nodes.has(event.nodeUid) && !isKnownParent) {
                    break;
                }
                this.removeSubtree(event.nodeUid, affected);
                if (event.isTrashed || !isKnownParent) {
                    break;
                }
                const entry = toRemoteEntry(await this.drive.getNode(event.nodeUid), this.logger);
                if (entry) {
                    this.setNode(entry);
                    if (entry.type === "folder") {
                        await this.loadSubtree(entry.uid, signal);
                    }
                    this.collectSubtreePaths(entry.uid, affected);
                }
                break;
            }
        }
        return affected;
    }

    /** Lists every descendant of `folderUid`, up to LISTING_CONCURRENCY folders at once. */
    private async loadSubtree(folderUid: string, signal?: AbortSignal): Promise<void> {
        const pending = [folderUid];
        const inFlight = new Set<Promise<void>>();
        let failure: { error: unknown } | undefined;
        while ((!failure && pending.length > 0) || inFlight.size > 0) {
            while (!failure && pending.length > 0 && inFlight.size < LISTING_CONCURRENCY) {
                const task: Promise<void> = this.loadChildren(pending.pop()!, signal)
                    .then(
                        (subfolders) => void pending.push(...subfolders),
                        // The first failure stops new listings; those in flight are awaited, not left rejecting.
                        (error: unknown) => void (failure ??= { error }),
                    )
                    .finally(() => inFlight.delete(task));
                inFlight.add(task);
            }
            await Promise.race(inFlight);
        }
        if (failure) {
            throw failure.error;
        }
    }

    /** Records the children of one folder and returns its subfolders. */
    private async loadChildren(folderUid: string, signal?: AbortSignal): Promise<string[]> {
        const subfolders: string[] = [];
        for await (const node of this.drive.iterateFolderChildren(folderUid, undefined, signal)) {
            const entry = toRemoteEntry(node, this.logger);
            if (entry) {
                this.setNode(entry);
                if (entry.type === "folder") {
                    subfolders.push(entry.uid);
                }
            }
        }
        this.onFolderListed?.();
        return subfolders;
    }

    private setNode(entry: RemoteEntry): void {
        this.addNode(entry);
        this.store.putRemoteNode(entry);
    }

    private addNode(entry: RemoteEntry): void {
        this.nodes.set(entry.uid, entry);
        let siblings = this.children.get(entry.parentUid);
        if (!siblings) {
            siblings = new Set();
            this.children.set(entry.parentUid, siblings);
        }
        siblings.add(entry.uid);
    }

    private deleteNode(uid: string): void {
        const entry = this.nodes.get(uid);
        if (entry) {
            this.children.get(entry.parentUid)?.delete(uid);
        }
        this.children.delete(uid);
        this.nodes.delete(uid);
        this.store.deleteRemoteNode(uid);
    }

    /** Removes the node and its descendants, adding their current paths to `affected`. */
    private removeSubtree(uid: string, affected: Set<string>): void {
        this.collectSubtreePaths(uid, affected);
        for (const descendant of this.descendantUids(uid)) {
            this.deleteNode(descendant);
        }
        this.deleteNode(uid);
    }

    private collectSubtreePaths(uid: string, into: Set<string>): void {
        for (const nodeUid of [uid, ...this.descendantUids(uid)]) {
            const nodePath = this.pathOf(nodeUid);
            if (nodePath !== undefined) {
                into.add(nodePath);
            }
        }
    }

    private descendantUids(uid: string): string[] {
        const result: string[] = [];
        const queue = [uid];
        for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
            for (const child of this.children.get(current) ?? []) {
                result.push(child);
                queue.push(child);
            }
        }
        return result;
    }
}

function toRemoteEntry(node: NodeEntity, logger: Logger): RemoteEntry | undefined {
    if (node.trashTime || !node.parentUid) {
        return undefined;
    }
    if (!node.name.ok) {
        logger.warn(`Skipping node ${node.uid}: its name cannot be decrypted`);
        return undefined;
    }
    if (!isSafeName(node.name.value)) {
        logger.warn(`Skipping node ${node.uid}: its name is not a valid local file name`);
        return undefined;
    }
    if (node.type === NodeType.Folder) {
        return { uid: node.uid, parentUid: node.parentUid, name: node.name.value, type: "folder" };
    }
    if (node.type !== NodeType.File || !node.activeRevision) {
        return undefined;
    }
    const revision = node.activeRevision;
    return {
        uid: node.uid,
        parentUid: node.parentUid,
        name: node.name.value,
        type: "file",
        revisionUid: revision.uid,
        ...(revision.claimedDigests?.sha1 !== undefined && { sha1: revision.claimedDigests.sha1 }),
        ...(revision.claimedSize !== undefined && { size: revision.claimedSize }),
    };
}

/**
 * Names are set by whoever writes to the Drive, shared folders included: one that is empty,
 * "." or "..", or holds "/" or NUL would resolve outside its folder once joined to the local root.
 * Names with the temporary-file prefix are skipped as the local scan skips them.
 */
export function isSafeName(name: string): boolean {
    return (
        name !== "" &&
        name !== "." &&
        name !== ".." &&
        !name.includes("/") &&
        !name.includes("\0") &&
        !name.startsWith(TEMP_PREFIX)
    );
}
