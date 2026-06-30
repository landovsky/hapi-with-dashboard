import { Hono } from 'hono'
import { z } from 'zod'
import type { ExtStore } from '../../ext/extStore'
import type { WebAppEnv } from '../middleware/auth'
import { resolveTtsProvider } from '../../ext/voiceProviders'

const ttsSchema = z.object({
    text: z.string().min(1).max(5000),
    voiceId: z.string().optional(),
    // When the caller is auto-reading a freshly arrived assistant reply it passes
    // the message's session + seq. A successful synth then records it as "played"
    // so re-entering the voice view never re-bills ElevenLabs for the same reply.
    // Omitted for replay/summary synths, which should never advance the mark.
    sessionId: z.string().optional(),
    seq: z.number().int().nonnegative().optional()
})

/**
 * Plain text-to-speech: read a finished Claude reply (or a summary) aloud.
 * Distinct from upstream /voice/* which is ElevenLabs ConvAI. Returns raw audio.
 *
 * Synthesis is the source of truth for "this reply was read aloud": the same
 * request that burns the ElevenLabs credit persists the played mark, so the two
 * can never drift. `GET /tts-state` lets the client skip already-spoken replies
 * before it ever issues the synth.
 */
export function createTtsRoutes(ext: ExtStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Map of sessionId → last assistant seq already read aloud, per namespace.
    app.get('/tts-state', (c) => {
        const namespace = c.get('namespace')
        return c.json({ ttsState: ext.getTtsState(namespace) })
    })

    app.post('/tts', async (c) => {
        const provider = resolveTtsProvider()
        if (!provider) return c.json({ error: 'No TTS provider configured' }, 400)

        const json = await c.req.json().catch(() => null)
        const parsed = ttsSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        const { sessionId, seq, ...synthReq } = parsed.data
        try {
            const result = await provider.synthesize(synthReq)
            // Persist the played mark only after a successful synth — a failed
            // synth (no audio, no credit consumed) must stay replayable.
            if (sessionId && seq !== undefined) {
                ext.markTtsPlayed(c.get('namespace'), sessionId, seq)
            }
            return new Response(result.audio, {
                headers: {
                    'Content-Type': result.contentType,
                    'Cache-Control': 'no-store'
                }
            })
        } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : 'TTS failed' }, 502)
        }
    })

    return app
}
