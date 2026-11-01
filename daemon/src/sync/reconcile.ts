/**
 * State of one side relative to the last synced state (base):
 * - absent: the file does not exist on this side;
 * - unchanged: it exists and matches base (same SHA-1 locally, same revision on Drive);
 * - changed: it exists and differs from base, or base has no entry (newly created).
 */
export type SideState = "absent" | "unchanged" | "changed";

/** Three-way view of a single file path. */
export interface PathState {
    /** The path was present on both sides after the last successful sync. */
    inBase: boolean;
    local: SideState;
    remote: SideState;
    /** Both sides exist and hold the same content (local SHA-1 equals the Drive revision's SHA-1). */
    sameContent: boolean;
}

export type SyncAction =
    | "none"
    | "upload"
    | "download"
    | "deleteLocal"
    | "deleteRemote"
    | "conflict"
    /** Both sides converged on their own (same content, or both deleted): only base is refreshed. */
    | "adoptBoth";

/**
 * Decides what to do with one file path given its three-way state.
 *
 * Expected behaviour, for instance:
 *   inBase, local=changed,   remote=unchanged → upload
 *   inBase, local=absent,    remote=unchanged → deleteRemote
 *   inBase, local=changed,   remote=changed, !sameContent → conflict
 *   !inBase, local=changed,  remote=absent → upload (created locally)
 */
export function reconcile({ inBase, local, remote, sameContent }: PathState): SyncAction {
    if (local === "absent" && remote === "absent") {
        return inBase ? "adoptBoth" : "none";
    }
    if (local === "absent") {
        // An edit wins over a deletion on the other side: the file is restored, never lost.
        return inBase && remote === "unchanged" ? "deleteRemote" : "download";
    }
    if (remote === "absent") {
        return inBase && local === "unchanged" ? "deleteLocal" : "upload";
    }
    if (local === "unchanged" && remote === "unchanged") {
        return "none";
    }
    if (local === "unchanged") {
        return "download";
    }
    if (remote === "unchanged") {
        return "upload";
    }
    // Both sides changed, or both were created without a base: identical content only needs base.
    return sameContent ? "adoptBoth" : "conflict";
}
