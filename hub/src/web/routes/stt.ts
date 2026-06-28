import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { resolveSttProvider } from '../../ext/voiceProviders'

/**
 * Speech-to-text: the voice view records audio, posts the raw bytes here, and
 * gets back a transcript that the client pastes (with its voice-mode preamble)
 * straight into the session. Fire-and-forget — no review step on the client.
 *
 * Accepts the audio as the raw request body. The MIME type comes from
 * Content-Type; an optional `?lang=cs` hints the recognizer.
 */
export function createSttRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/stt', async (c) => {
        const provider = resolveSttProvider()
        if (!provider) return c.json({ error: 'No STT provider configured' }, 400)

        const contentType = c.req.header('content-type') || 'audio/webm'
        const audio = await c.req.arrayBuffer()
        if (!audio || audio.byteLength === 0) return c.json({ error: 'Empty audio body' }, 400)

        const language = c.req.query('lang') || undefined
        try {
            const result = await provider.transcribe({ audio, contentType, language })
            return c.json({ text: result.text, language: result.language })
        } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : 'STT failed' }, 502)
        }
    })

    return app
}
