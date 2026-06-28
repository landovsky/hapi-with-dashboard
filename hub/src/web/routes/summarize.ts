import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import { callFastModel, isLlmConfigured } from '../../ext/llm'

const messageSchema = z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string()
})

const summarizeSchema = z.object({
    // The client already renders the chat, so it sends the last N messages here.
    // Keeps us decoupled from where the transcript is actually stored.
    messages: z.array(messageSchema).min(1).max(100),
    sessionName: z.string().optional()
})

const SYSTEM = [
    'You are a "catch me up" assistant for a hands-busy user (often driving) who is',
    'returning to one of several parallel Claude Code coding/assistant sessions.',
    'Summarize the recent conversation in 2–4 short spoken sentences: where things',
    'stand and what (if anything) needs the user. Plain speakable Czech, no lists,',
    'no code, no markdown.'
].join(' ')

/**
 * POST /api/summarize — side-call to a fast model (Haiku) that recaps the last N
 * messages. Returns text only; the client pipes it to /api/tts to be spoken, so
 * the two stay composable. Does not touch the session's own history.
 */
export function createSummarizeRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/summarize', async (c) => {
        if (!isLlmConfigured()) return c.json({ error: 'LLM not configured (GEMINI_API_KEY)' }, 400)

        const json = await c.req.json().catch(() => null)
        const parsed = summarizeSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        const transcript = parsed.data.messages
            .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text}`)
            .join('\n')
        const header = parsed.data.sessionName ? `Session: ${parsed.data.sessionName}\n\n` : ''

        try {
            const summary = await callFastModel({
                system: SYSTEM,
                prompt: `${header}Recent conversation:\n${transcript}`,
                maxTokens: 400
            })
            return c.json({ summary })
        } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : 'Summarize failed' }, 502)
        }
    })

    return app
}
