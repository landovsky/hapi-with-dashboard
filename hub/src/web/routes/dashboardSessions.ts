import { toSessionSummary } from '@hapi/protocol'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSyncEngine } from './guards'

const DEFAULT_DAYS = 5
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Filtered session list for the voice dashboard. Additive — upstream's
 * `/api/sessions` is left untouched; this is a separate read-only view.
 *
 * With 900+ sessions the full list is heavy and almost all of it is stale, so
 * by default we return only sessions touched in the last N days (the backend
 * filter). `?all=true` opts back into everything (the "show all" checkbox);
 * `?days=` overrides the window. We always report `total` so the UI can say
 * "showing 23 of 912".
 */
export function createDashboardSessionsRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/dashboard/sessions', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const namespace = c.get('namespace')
        const all = c.req.query('all') === 'true'
        const daysRaw = Number(c.req.query('days'))
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : DEFAULT_DAYS
        const cutoff = Date.now() - days * DAY_MS

        // Archived sessions are "put away" — never surface them on the board,
        // even under "show all". Archiving sets metadata.lifecycleState =
        // 'archived' (see syncEngine), so filter on that before anything else.
        const records = engine.getSessionsByNamespace(namespace)
            .filter((s) => s.metadata?.lifecycleState !== 'archived')
        const recent = all ? records : records.filter((s) => s.updatedAt >= cutoff)
        const sessions = recent
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((s) => toSessionSummary(s))

        return c.json({ sessions, total: records.length, shown: sessions.length, days })
    })

    // Archive a session straight from the board (#1) — works for idle rows too,
    // which upstream's /archive rejects. Recoverable (reopen revives it); the
    // list filter above then hides it.
    app.post('/dashboard/sessions/:id/archive', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }
        const namespace = c.get('namespace')
        const id = c.req.param('id')
        const exists = engine.getSessionsByNamespace(namespace).some((s) => s.id === id)
        if (!exists) {
            return c.json({ error: 'Session not found' }, 404)
        }
        await engine.archiveFromDashboard(id, namespace)
        return c.json({ ok: true })
    })

    return app
}
