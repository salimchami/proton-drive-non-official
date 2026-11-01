import type { LocalEntry } from "./localTree.ts";
import { type PathState, reconcile, type SideState, type SyncAction } from "./reconcile.ts";
import type { RemoteEntry } from "./remoteTree.ts";
import type { BaseEntry } from "./state.ts";

export type FolderAction =
    | "createLocalFolder"
    | "createRemoteFolder"
    | "deleteLocalFolder"
    | "deleteRemoteFolder"
    /** Present on both sides (or gone from both): only base is refreshed. */
    | "adoptFolder";

export interface PlannedAction {
    path: string;
    action: SyncAction | FolderAction;
}

export interface Snapshot {
    base: ReadonlyMap<string, BaseEntry>;
    local: ReadonlyMap<string, LocalEntry>;
    remote: ReadonlyMap<string, RemoteEntry>;
}

/**
 * Plans the actions for `paths` and all their descendants.
 * Creations and transfers come parents first, then deletions children first;
 * a folder deleted on one side is deleted as a whole on the other only when every
 * descendant would be deleted anyway, otherwise it is recreated.
 */
export function plan(snapshot: Snapshot, paths: Iterable<string>): PlannedAction[] {
    const scope = withDescendants(snapshot, paths);
    const decisions = new Map<string, SyncAction | FolderAction>();

    // Deepest first, so a folder sees its descendants' decisions.
    for (const path of [...scope].sort((a, b) => depth(b) - depth(a))) {
        const localType = snapshot.local.get(path)?.type;
        const remoteType = snapshot.remote.get(path)?.type;
        const decision =
            localType && remoteType && localType !== remoteType
                ? "conflict"
                : isFolderPath(snapshot, path)
                  ? planFolder(snapshot, path, decisions)
                  : reconcile(fileState(snapshot, path));
        decisions.set(path, decision);
    }

    // A folder deleted as a whole carries its descendants.
    for (const [path, decision] of decisions) {
        if (decision === "deleteLocalFolder" || decision === "deleteRemoteFolder") {
            for (const other of decisions.keys()) {
                if (other.startsWith(`${path}/`)) {
                    decisions.delete(other);
                }
            }
        }
    }

    const actions = [...decisions]
        .filter(([, action]) => action !== "none")
        .map(([path, action]) => ({ path, action }));
    const deletions = actions.filter((a) => a.action.startsWith("delete"));
    return [
        ...actions.filter((a) => !a.action.startsWith("delete")).sort((a, b) => depth(a.path) - depth(b.path)),
        ...deletions.sort((a, b) => depth(b.path) - depth(a.path)),
    ];
}

export function fileState({ base, local, remote }: Snapshot, path: string): PathState {
    const baseEntry = base.get(path);
    const localEntry = local.get(path);
    const remoteEntry = remote.get(path);

    const localState: SideState = !localEntry
        ? "absent"
        : baseEntry && localEntry.sha1 === baseEntry.sha1
          ? "unchanged"
          : "changed";
    const remoteState: SideState = !remoteEntry
        ? "absent"
        : baseEntry && remoteEntry.revisionUid === baseEntry.remoteRevisionUid
          ? "unchanged"
          : "changed";

    return {
        inBase: baseEntry !== undefined,
        local: localState,
        remote: remoteState,
        sameContent:
            localEntry?.sha1 !== undefined && remoteEntry?.sha1 !== undefined && localEntry.sha1 === remoteEntry.sha1,
    };
}

function planFolder(
    { base, local, remote }: Snapshot,
    path: string,
    decisions: ReadonlyMap<string, SyncAction | FolderAction>,
): FolderAction | "none" {
    const inBase = base.has(path);
    const onLocal = local.get(path)?.type === "folder";
    const onRemote = remote.get(path)?.type === "folder";
    const descendantDecisions = [...decisions].filter(([other]) => other.startsWith(`${path}/`)).map(([, d]) => d);
    const allDeleted = (file: SyncAction, folder: FolderAction) =>
        descendantDecisions.every((d) => d === file || d === folder || d === "adoptBoth" || d === "adoptFolder");

    if (onLocal && onRemote) {
        return inBase ? "none" : "adoptFolder";
    }
    if (onLocal) {
        return inBase && allDeleted("deleteLocal", "deleteLocalFolder") ? "deleteLocalFolder" : "createRemoteFolder";
    }
    if (onRemote) {
        return inBase && allDeleted("deleteRemote", "deleteRemoteFolder") ? "deleteRemoteFolder" : "createLocalFolder";
    }
    return inBase ? "adoptFolder" : "none";
}

function withDescendants({ base, local, remote }: Snapshot, paths: Iterable<string>): Set<string> {
    const roots = [...paths];
    if (roots.includes("")) {
        return new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
    }
    const result = new Set<string>();
    for (const source of [base.keys(), local.keys(), remote.keys()]) {
        for (const candidate of source) {
            if (roots.some((root) => candidate === root || candidate.startsWith(`${root}/`))) {
                result.add(candidate);
            }
        }
    }
    return result;
}

function isFolderPath({ base, local, remote }: Snapshot, path: string): boolean {
    return [base.get(path), local.get(path), remote.get(path)].some((entry) => entry?.type === "folder");
}

function depth(path: string): number {
    return path.split("/").length;
}
