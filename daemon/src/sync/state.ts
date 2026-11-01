import { DatabaseSync } from "node:sqlite";

import type { RemoteEntry } from "./remoteTree.ts";

export type EntryType = "file" | "folder";

/** One path as it was on both sides after the last successful sync. */
export interface BaseEntry {
    path: string;
    type: EntryType;
    remoteUid: string;
    /** Files only: what was synced, used to tell whether either side changed since. */
    sha1?: string;
    size?: number;
    localMtimeMs?: number;
    remoteRevisionUid?: string;
}

interface EntryRow {
    path: string;
    type: EntryType;
    remote_uid: string;
    sha1: string | null;
    size: number | null;
    local_mtime_ms: number | null;
    remote_revision_uid: string | null;
}

interface RemoteNodeRow {
    uid: string;
    parent_uid: string;
    name: string;
    type: EntryType;
    revision_uid: string | null;
    sha1: string | null;
    size: number | null;
}

/**
 * Persistent sync state: the base snapshot, the last processed Drive event per scope and the mirror
 * of the Drive tree, so a restart catches up from events instead of listing the whole Drive.
 */
export class StateDb {
    private readonly db: DatabaseSync;

    constructor(file: string) {
        this.db = new DatabaseSync(file);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS entries (
                path TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                remote_uid TEXT NOT NULL,
                sha1 TEXT,
                size INTEGER,
                local_mtime_ms INTEGER,
                remote_revision_uid TEXT
            );
            CREATE TABLE IF NOT EXISTS event_cursors (
                scope_id TEXT PRIMARY KEY,
                event_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS remote_nodes (
                uid TEXT PRIMARY KEY,
                parent_uid TEXT NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                revision_uid TEXT,
                sha1 TEXT,
                size INTEGER
            );
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
    }

    allEntries(): Map<string, BaseEntry> {
        const rows = this.db.prepare("SELECT * FROM entries").all() as unknown as EntryRow[];
        return new Map(rows.map((row) => [row.path, fromRow(row)]));
    }

    putEntry(entry: BaseEntry): void {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO entries (path, type, remote_uid, sha1, size, local_mtime_ms, remote_revision_uid)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                entry.path,
                entry.type,
                entry.remoteUid,
                entry.sha1 ?? null,
                entry.size ?? null,
                entry.localMtimeMs ?? null,
                entry.remoteRevisionUid ?? null,
            );
    }

    deleteEntry(path: string): void {
        this.db.prepare("DELETE FROM entries WHERE path = ?").run(path);
    }

    lastEventId(scopeId: string): string | undefined {
        const row = this.db.prepare("SELECT event_id FROM event_cursors WHERE scope_id = ?").get(scopeId) as
            | { event_id: string }
            | undefined;
        return row?.event_id;
    }

    setLastEventId(scopeId: string, eventId: string): void {
        this.db.prepare("INSERT OR REPLACE INTO event_cursors (scope_id, event_id) VALUES (?, ?)").run(scopeId, eventId);
    }

    remoteNodes(): RemoteEntry[] {
        const rows = this.db.prepare("SELECT * FROM remote_nodes").all() as unknown as RemoteNodeRow[];
        return rows.map(fromRemoteRow);
    }

    putRemoteNode(entry: RemoteEntry): void {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO remote_nodes (uid, parent_uid, name, type, revision_uid, sha1, size)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                entry.uid,
                entry.parentUid,
                entry.name,
                entry.type,
                entry.revisionUid ?? null,
                entry.sha1 ?? null,
                entry.size ?? null,
            );
    }

    deleteRemoteNode(uid: string): void {
        this.db.prepare("DELETE FROM remote_nodes WHERE uid = ?").run(uid);
    }

    /** Drops the mirror and its completion mark, before a full listing. */
    clearRemoteNodes(): void {
        this.db.exec("DELETE FROM remote_nodes; DELETE FROM meta WHERE key = 'remote_tree_root';");
    }

    /** Root folder whose full listing completed; the mirror is only usable for that root. */
    completeRemoteTreeRoot(): string | undefined {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = 'remote_tree_root'").get() as
            | { value: string }
            | undefined;
        return row?.value;
    }

    setCompleteRemoteTreeRoot(rootUid: string): void {
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('remote_tree_root', ?)").run(rootUid);
    }

    /** Forgets everything; used when the synced folder pair or the account changes. */
    reset(): void {
        this.db.exec("DELETE FROM entries; DELETE FROM event_cursors; DELETE FROM remote_nodes; DELETE FROM meta;");
    }

    close(): void {
        this.db.close();
    }
}

function fromRow(row: EntryRow): BaseEntry {
    return {
        path: row.path,
        type: row.type,
        remoteUid: row.remote_uid,
        ...(row.sha1 !== null && { sha1: row.sha1 }),
        ...(row.size !== null && { size: row.size }),
        ...(row.local_mtime_ms !== null && { localMtimeMs: row.local_mtime_ms }),
        ...(row.remote_revision_uid !== null && { remoteRevisionUid: row.remote_revision_uid }),
    };
}

function fromRemoteRow(row: RemoteNodeRow): RemoteEntry {
    return {
        uid: row.uid,
        parentUid: row.parent_uid,
        name: row.name,
        type: row.type,
        ...(row.revision_uid !== null && { revisionUid: row.revision_uid }),
        ...(row.sha1 !== null && { sha1: row.sha1 }),
        ...(row.size !== null && { size: row.size }),
    };
}
