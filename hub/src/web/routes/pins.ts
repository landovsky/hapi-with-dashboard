import { Hono } from 'hono'
import { z } from 'zod'
import type { ExtStore } from '../../ext/extStore'
import type { WebAppEnv } from '../middleware/auth'

const addPinSchema = z.object({
    position: z.number().int().nonnegative().optional()
})

const reorderSchema = z.object({
    sessionIds: z.array(z.string().min(1))
})

export function createPinsRoutes(ext: ExtStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // List pinned sessions for the caller's namespace, in manual order.
    app.get('/pins', (c) => {
        const namespace = c.get('namespace')
        return c.json({ pins: ext.listPins(namespace) })
    })

    // Pin a session (idempotent upsert). Lands at the end unless a position is given.
    app.put('/pins/:sessionId', async (c) => {
        const namespace = c.get('namespace')
        const sessionId = c.req.param('sessionId')
        const json = await c.req.json().catch(() => ({}))
        const parsed = addPinSchema.safeParse(json ?? {})
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        ext.addPin(namespace, sessionId, parsed.data.position)
        return c.json({ ok: true })
    })

    app.delete('/pins/:sessionId', (c) => {
        const namespace = c.get('namespace')
        ext.removePin(namespace, c.req.param('sessionId'))
        return c.json({ ok: true })
    })

    // Manual reorder — never auto-sorted. Client sends the desired top-to-bottom order.
    app.post('/pins/reorder', async (c) => {
        const namespace = c.get('namespace')
        const json = await c.req.json().catch(() => null)
        const parsed = reorderSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        ext.reorderPins(namespace, parsed.data.sessionIds)
        return c.json({ ok: true })
    })

    return app
}
