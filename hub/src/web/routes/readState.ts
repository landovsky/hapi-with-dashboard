import { Hono } from 'hono'
import { z } from 'zod'
import type { ExtStore } from '../../ext/extStore'
import type { WebAppEnv } from '../middleware/auth'

const markSeenSchema = z.object({
    seq: z.number().int().nonnegative()
})

/**
 * Read/unread tracking. The dashboard marks a tile "unread" when a session's
 * live `seq` (from /api/sessions) exceeds the last-seen seq stored here. This is
 * what lets the grid stay in a STABLE manual order while still signalling that a
 * session advanced — no auto-reordering on state change.
 */
export function createReadStateRoutes(ext: ExtStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Map of sessionId → last-seen seq for the namespace.
    app.get('/read-state', (c) => {
        const namespace = c.get('namespace')
        return c.json({ readState: ext.getReadState(namespace) })
    })

    // Mark a session seen up to `seq` (monotonic — never lowers the mark).
    app.put('/read-state/:sessionId', async (c) => {
        const namespace = c.get('namespace')
        const sessionId = c.req.param('sessionId')
        const json = await c.req.json().catch(() => null)
        const parsed = markSeenSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        ext.markSeen(namespace, sessionId, parsed.data.seq)
        return c.json({ ok: true })
    })

    return app
}
