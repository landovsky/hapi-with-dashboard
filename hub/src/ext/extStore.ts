import { Database } from 'bun:sqlite'
import { dirname, join } from 'node:path'

/**
 * Additive, fork-local persistence that lives in its OWN SQLite file
 * (`hapi-ext.db`), separate from upstream's `hapi.db`.
 *
 * Why a separate database instead of new tables on the upstream `Store`:
 * `hub/src/store/index.ts` owns SCHEMA_VERSION, REQUIRED_TABLES and the
 * migration ladder, and upstream edits it on almost every release. Adding our
 * tables there would conflict on every `git pull` of upstream. A standalone DB
 * with `CREATE TABLE IF NOT EXISTS` is fully decoupled — upstream never touches
 * it, and we never bump their schema version.
 *
 * Tables:
 *  - pins        : per-namespace pinned sessions, manually ordered
 *  - read_state  : per-namespace last-seen seq, for the unread marker
 *    (a session is "unread" when its live `seq` exceeds last_seen_seq)
 */

export interface Pin {
    sessionId: string
    position: number
    createdAt: number
}

export class ExtStore {
    private readonly db: Database

    constructor(dbPath: string) {
        this.db = new Database(dbPath, { create: true, readwrite: true, strict: true })
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA synchronous = NORMAL')
        this.db.exec('PRAGMA busy_timeout = 5000')
        this.createSchema()
    }

    /** Default path: alongside the main hapi.db, e.g. ~/.hapi/hapi-ext.db */
    static defaultPathFor(mainDbPath: string): string {
        if (mainDbPath === ':memory:' || mainDbPath.startsWith('file::memory:')) return ':memory:'
        return process.env.HAPI_EXT_DB_PATH || join(dirname(mainDbPath), 'hapi-ext.db')
    }

    private createSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS pins (
                namespace  TEXT NOT NULL,
                session_id TEXT NOT NULL,
                position   INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, session_id)
            );
            CREATE INDEX IF NOT EXISTS idx_pins_namespace ON pins(namespace, position);

            CREATE TABLE IF NOT EXISTS read_state (
                namespace     TEXT NOT NULL,
                session_id    TEXT NOT NULL,
                last_seen_seq INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL,
                PRIMARY KEY (namespace, session_id)
            );
        `)
    }

    // ---- pins ---------------------------------------------------------------

    listPins(namespace: string): Pin[] {
        const rows = this.db.prepare(
            'SELECT session_id, position, created_at FROM pins WHERE namespace = ? ORDER BY position ASC, created_at ASC'
        ).all(namespace) as Array<{ session_id: string; position: number; created_at: number }>
        return rows.map((r) => ({ sessionId: r.session_id, position: r.position, createdAt: r.created_at }))
    }

    /** Pin a session. New pins land at the end unless an explicit position is given. */
    addPin(namespace: string, sessionId: string, position?: number): void {
        const now = Date.now()
        const pos = position ?? this.nextPosition(namespace)
        this.db.prepare(`
            INSERT INTO pins (namespace, session_id, position, created_at)
            VALUES (@namespace, @session_id, @position, @created_at)
            ON CONFLICT(namespace, session_id)
            DO UPDATE SET position = excluded.position
        `).run({ namespace, session_id: sessionId, position: pos, created_at: now })
    }

    removePin(namespace: string, sessionId: string): void {
        this.db.prepare('DELETE FROM pins WHERE namespace = ? AND session_id = ?').run(namespace, sessionId)
    }

    /** Apply a manual ordering: sessionIds in the desired top-to-bottom order. */
    reorderPins(namespace: string, sessionIds: string[]): void {
        const stmt = this.db.prepare('UPDATE pins SET position = ? WHERE namespace = ? AND session_id = ?')
        const tx = this.db.transaction((ids: string[]) => {
            ids.forEach((id, i) => stmt.run(i, namespace, id))
        })
        tx(sessionIds)
    }

    private nextPosition(namespace: string): number {
        const row = this.db.prepare(
            'SELECT COALESCE(MAX(position), -1) AS maxPos FROM pins WHERE namespace = ?'
        ).get(namespace) as { maxPos: number }
        return row.maxPos + 1
    }

    // ---- read-state ---------------------------------------------------------

    /** Map of sessionId → last-seen seq for the namespace. */
    getReadState(namespace: string): Record<string, number> {
        const rows = this.db.prepare(
            'SELECT session_id, last_seen_seq FROM read_state WHERE namespace = ?'
        ).all(namespace) as Array<{ session_id: string; last_seen_seq: number }>
        const out: Record<string, number> = {}
        for (const r of rows) out[r.session_id] = r.last_seen_seq
        return out
    }

    /** Mark a session seen up to `seq`. Monotonic: never lowers an existing mark. */
    markSeen(namespace: string, sessionId: string, seq: number): void {
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO read_state (namespace, session_id, last_seen_seq, updated_at)
            VALUES (@namespace, @session_id, @seq, @updated_at)
            ON CONFLICT(namespace, session_id)
            DO UPDATE SET
                last_seen_seq = MAX(read_state.last_seen_seq, excluded.last_seen_seq),
                updated_at    = excluded.updated_at
        `).run({ namespace, session_id: sessionId, seq, updated_at: now })
    }

    close(): void {
        this.db.close()
    }
}
