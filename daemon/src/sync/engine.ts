import { DriveEventType, NodeType, type ProtonDriveClient } from "@protontech/drive-sdk";

import type { Settings } from "../settings.ts";
import type { Logger } from "../vendor/proton-account/index.ts";
import { type ExecutionContext, execute } from "./executor.ts";
import {
    assertLocalRoot,
    countDeletedFiles,
    DELETION_APPROVAL_THRESHOLD,
    LocalRootMissingError,
    unapprovedDeletions,
} from "./guard.ts";
import { type LocalEntry, scanLocal, watchLocal } from "./localTree.ts";
import { plan, type PlannedAction } from "./planner.ts";
import type { Progress } from "./progress.ts";
import { RemoteTree } from "./remoteTree.ts";
import type { StateDb } from "./state.ts";

const LOCAL_DEBOUNCE_MS = 1000;
/** Paths listed with held deletions; the count covers all of them. */
const HELD_SAMPLE_SIZE = 20;

export interface HeldDeletions {
    /** Files that the held plan would trash. */
    count: number;
    paths: string[];
}

export interface EngineOptions {
    /** Plan only: print the actions, execute none. */
    dryRun: boolean;
    onPlan: (actions: PlannedAction[]) => void;
    onResult?: ExecutionContext["onResult"];
    /** True while planned actions are being executed. */
    onBusy?: (busy: boolean) => void;
    /** A plan trashing too many files is held until resolveHeldDeletions; undefined once resolved. */
    onDeletionsHeld?: (held: HeldDeletions | undefined) => void;
    /** The local folder disappeared: nothing more is planned, the engine must be restarted. */
    onLocalRootMissing?: (error: LocalRootMissingError) => void;
    /** Listing or transfer progress; undefined once a plan has been executed. */
    onProgress?: (progress: Progress | undefined) => void;
}

/**
 * Keeps the three views (base, local, remote) current and plans actions whenever one changes,
 * then executes them unless `dryRun`. Every update runs on a single serial queue, so plans
 * and executions always see a consistent snapshot.
 */
export class SyncEngine {
    private remote!: RemoteTree;
    private local = new Map<string, LocalEntry>();
    private readonly dirtyLocalPaths = new Set<string>();
    private debounceTimer?: NodeJS.Timeout;
    private queue: Promise<void> = Promise.resolve();
    /** Paths of the held plan's deletions; while set, nothing is executed. */
    private heldPaths?: string[];
    private readonly approvedDeletions = new Set<string>();
    /** Folders listed by the full listing in progress (at start-up or on a TreeRefresh event). */
    private listedFolders = 0;
    private halted = false;

    constructor(
        private readonly sdk: ProtonDriveClient,
        private readonly settings: Settings,
        private readonly state: StateDb,
        private readonly logger: Logger,
        private readonly options: EngineOptions,
    ) {}

    async start(signal: AbortSignal): Promise<void> {
        await assertLocalRoot(this.settings.localRoot);
        const rootFolder = await this.resolveRemoteFolder(signal);
        const scopeId = rootFolder.treeEventScopeId;

        this.remote = new RemoteTree(this.sdk, rootFolder.uid, this.state, this.logger, () =>
            this.options.onProgress?.({ phase: "listing", folders: ++this.listedFolders }),
        );
        if (this.state.lastEventId(scopeId) && this.remote.restore()) {
            // Catch up on the changes made while stopped before planning: a stale tree would take a
            // remote edit for an unchanged file and overwrite it with the local version.
            await this.applyRemoteEvents(scopeId, signal);
        } else {
            // Take the event cursor before listing, so no change between the two is lost.
            for await (const event of this.sdk.iterateEvents(scopeId, undefined, signal)) {
                this.state.setLastEventId(scopeId, event.eventId);
            }
            await this.remote.loadAll(signal);
            this.endListing();
        }
        this.local = definedEntries(await scanLocal(this.settings.localRoot, this.state.allEntries()));
        await this.enqueue(() => this.planFor([""]));
        // The initial plan may have halted the engine, whose run is then aborted.
        signal.throwIfAborted();

        const watcher = watchLocal(this.settings.localRoot, (relPath) => this.markLocalDirty(relPath));
        const scheduler = await this.sdk.getEventScheduler((polledScopeId) =>
            this.enqueue(() => this.pollRemoteEvents(polledScopeId, signal)),
        );
        scheduler.addScope(scopeId);

        signal.addEventListener("abort", () => {
            watcher.close();
            clearTimeout(this.debounceTimer);
            scheduler.removeScope(scopeId);
            // A poll still in the queue re-arms its timer once it settles (EventScheduler.poll).
            void this.queue.finally(() => scheduler.removeScope(scopeId));
        });
    }

    /** Executes the held plan's deletions (approve) or restores the files from the other side. */
    resolveHeldDeletions(approve: boolean): Promise<void> {
        return this.enqueue(async () => {
            const paths = this.heldPaths;
            if (!paths) {
                return;
            }
            this.heldPaths = undefined;
            this.options.onDeletionsHeld?.(undefined);
            if (approve) {
                for (const path of paths) {
                    this.approvedDeletions.add(path);
                }
            } else {
                // Without a base entry, the side still holding a file reads as a creation and is copied back.
                for (const known of this.state.allEntries().keys()) {
                    if (paths.some((path) => known === path || known.startsWith(`${path}/`))) {
                        this.state.deleteEntry(known);
                    }
                }
            }
            await this.planFor([""]);
        });
    }

    private markLocalDirty(relPath: string): void {
        this.dirtyLocalPaths.add(relPath);
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            const paths = [...this.dirtyLocalPaths];
            this.dirtyLocalPaths.clear();
            void this.enqueue(() => this.rescanLocal(paths));
        }, LOCAL_DEBOUNCE_MS);
    }

    private async rescanLocal(paths: string[]): Promise<void> {
        const scanned = await scanLocal(this.settings.localRoot, this.state.allEntries(), paths);
        for (const [relPath, entry] of scanned) {
            if (entry) {
                this.local.set(relPath, entry);
            } else {
                for (const known of [...this.local.keys()]) {
                    if (known === relPath || known.startsWith(`${relPath}/`)) {
                        this.local.delete(known);
                    }
                }
            }
        }
        await this.planFor(paths);
    }

    private async pollRemoteEvents(scopeId: string, signal: AbortSignal): Promise<void> {
        const affected = await this.applyRemoteEvents(scopeId, signal);
        if (affected.size > 0) {
            await this.planFor(affected);
        }
    }

    /** Applies the events since the stored cursor to the tree, advancing the cursor after each one. */
    private async applyRemoteEvents(scopeId: string, signal: AbortSignal): Promise<Set<string>> {
        const affected = new Set<string>();
        for await (const event of this.sdk.iterateEvents(scopeId, this.state.lastEventId(scopeId), signal)) {
            if (event.type !== DriveEventType.FastForward) {
                for (const relPath of await this.remote.applyEvent(event, signal)) {
                    affected.add(relPath);
                }
            }
            this.state.setLastEventId(scopeId, event.eventId);
        }
        this.endListing();
        return affected;
    }

    /** Clears the listing progress once a full listing ended. */
    private endListing(): void {
        if (this.listedFolders > 0) {
            this.listedFolders = 0;
            this.options.onProgress?.(undefined);
        }
    }

    private async planFor(paths: Iterable<string>): Promise<void> {
        if (this.halted) {
            return;
        }
        try {
            await assertLocalRoot(this.settings.localRoot);
        } catch (error) {
            if (!(error instanceof LocalRootMissingError)) {
                throw error;
            }
            this.halted = true;
            this.options.onLocalRootMissing?.(error);
            return;
        }
        const base = this.state.allEntries();
        const remote = this.remote.snapshot();
        const actions = plan({ base, local: this.local, remote }, paths);
        if (actions.length === 0) {
            return;
        }
        this.options.onPlan(actions);
        if (this.options.dryRun || this.heldPaths) {
            // While deletions are held, the views stay current; resolving them plans the whole tree.
            return;
        }
        const deletions = unapprovedDeletions(actions, this.approvedDeletions);
        const count = countDeletedFiles(deletions, base);
        if (count > DELETION_APPROVAL_THRESHOLD) {
            this.heldPaths = deletions.map(({ path }) => path);
            this.options.onDeletionsHeld?.({ count, paths: this.heldPaths.slice(0, HELD_SAMPLE_SIZE) });
            return;
        }
        const progress = {
            phase: "transferring" as const,
            actionsDone: 0,
            actionsTotal: actions.length,
            bytesDone: 0,
            bytesTotal: actions.reduce(
                (total, { path, action }) =>
                    total +
                    (action === "upload"
                        ? (this.local.get(path)?.size ?? 0)
                        : action === "download"
                          ? (remote.get(path)?.size ?? 0)
                          : 0),
                0,
            ),
            currentPath: undefined as string | undefined,
        };
        const report = () => this.options.onProgress?.({ ...progress });
        this.options.onBusy?.(true);
        report();
        try {
            await execute(
                {
                    localRoot: this.settings.localRoot,
                    drive: this.sdk,
                    state: this.state,
                    local: this.local,
                    remote: this.remote,
                    logger: this.logger,
                    onActionStart: (relPath) => {
                        progress.currentPath = relPath;
                        report();
                    },
                    onBytes: (delta) => {
                        progress.bytesDone = Math.max(0, progress.bytesDone + delta);
                        report();
                    },
                    onResult: (action, relPath, error) => {
                        progress.actionsDone++;
                        report();
                        this.options.onResult?.(action, relPath, error);
                    },
                },
                actions,
            );
        } finally {
            this.approvedDeletions.clear();
            this.options.onProgress?.(undefined);
            this.options.onBusy?.(false);
        }
    }

    private enqueue(task: () => Promise<void>): Promise<void> {
        this.queue = this.queue.then(task).catch((error: unknown) => this.logger.error("Sync step failed", error));
        return this.queue;
    }

    /** Resolves `settings.remotePath` from the "My files" root, folder by folder. */
    private async resolveRemoteFolder(signal: AbortSignal) {
        let folder = await this.sdk.getMyFilesRootFolder();
        for (const name of this.settings.remotePath.split("/").filter(Boolean)) {
            let match;
            for await (const child of this.sdk.iterateFolderChildren(folder, { type: NodeType.Folder }, signal)) {
                if (child.name.ok && child.name.value === name && !child.trashTime) {
                    match = child;
                    break;
                }
            }
            if (!match) {
                throw new Error(`Drive folder not found: ${this.settings.remotePath}`);
            }
            folder = match;
        }
        return folder;
    }
}

function definedEntries(scanned: Map<string, LocalEntry | undefined>): Map<string, LocalEntry> {
    const result = new Map<string, LocalEntry>();
    for (const [relPath, entry] of scanned) {
        if (entry) {
            result.set(relPath, entry);
        }
    }
    return result;
}
