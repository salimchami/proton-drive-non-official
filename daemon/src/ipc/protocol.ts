/**
 * Daemon ↔ UI protocol over the Unix socket: one JSON object per line.
 * The UI sends requests and receives responses with the same id; the daemon also pushes events.
 */
import type { Settings } from "../settings.ts";
import type { Progress } from "../sync/progress.ts";

export type { Progress, Settings };

export type SyncState =
    | "signedOut"
    | "signingIn"
    | "needsSettings"
    | "starting"
    | "idle"
    | "syncing"
    /** A plan would trash too many files: nothing runs until the user approves or restores. */
    | "awaitingApproval"
    | "error";

export interface Status {
    state: SyncState;
    /** Present while state is "signingIn": the URL to open in a browser. */
    signInUrl?: string;
    settings?: Settings;
    /** Present while the Drive is listed or a plan is executed. */
    progress?: Progress;
    /** Present while state is "awaitingApproval". */
    heldDeletions?: HeldDeletions;
    /** Last failure that stopped the engine, shown while state is "error". */
    error?: string;
}

/** A plan held because it would trash too many files. */
export interface HeldDeletions {
    /** Files that the plan would trash. */
    count: number;
    /** A sample of the deleted paths (files or whole folders). */
    paths: string[];
}

export interface Activity {
    time: string;
    action: string;
    path: string;
    /** Set when the action failed; it will be planned again. */
    error?: string;
}

export type Request =
    | { id: number; method: "status" }
    | { id: number; method: "login" }
    | { id: number; method: "logout" }
    | { id: number; method: "setSettings"; settings: Settings }
    | { id: number; method: "recentActivity" }
    | { id: number; method: "resolveDeletions"; approve: boolean }
    | { id: number; method: "outdated" };

export type Response = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string };

export type DaemonEvent =
    | { event: "status"; status: Status }
    | { event: "activity"; activity: Activity }
    /** A newer daemon was installed; answered by restarting the service. */
    | { event: "outdated" };
