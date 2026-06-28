import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import { resolveTtsProvider } from '../../ext/voiceProviders'

const ttsSchema = z.object({
    text: z.string().min(1).max(5000),
    voiceId: z.string().optional()
})

/**
 * Plain text-to-speech: read a finished Claude reply (or a summary) aloud.
 * Distinct from upstream /voice/* which is ElevenLabs ConvAI. Returns raw audio.
 */
export function createTtsRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/tts', async (c) => {
        const provider = resolveTtsProvider()
        if (!provider) return c.json({ error: 'No TTS provider configured' }, 400)

        const json = await c.req.json().catch(() => null)
        const parsed = ttsSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        try {
            const result = await provider.synthesize(parsed.data)
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
