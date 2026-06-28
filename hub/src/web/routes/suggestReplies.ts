import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import { callFastModel, isLlmConfigured } from '../../ext/llm'

const messageSchema = z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string()
})

const suggestSchema = z.object({
    // A little context helps; the latest assistant turn must be last.
    messages: z.array(messageSchema).min(1).max(40)
})

const SYSTEM = [
    'You generate 3–4 very short reply options a busy user could TAP instead of',
    'typing or speaking, in response to the latest Claude message in a coding/',
    'assistant session. Each option: max ~6 words, plain Czech, directly usable as',
    'the user\'s next message (e.g. "Ano, pokračuj", "Ne, zastav", "Vysvětli víc").',
    'Prefer decisions/approvals when Claude is asking something. Respond with ONLY',
    'a JSON array of strings, nothing else.'
].join(' ')

function parseReplies(raw: string): string[] {
    try {
        const start = raw.indexOf('[')
        const end = raw.lastIndexOf(']')
        if (start === -1 || end === -1) return []
        const arr = JSON.parse(raw.slice(start, end + 1)) as unknown
        if (!Array.isArray(arr)) return []
        return arr.filter((s): s is string => typeof s === 'string').slice(0, 4)
    } catch {
        return []
    }
}

/**
 * POST /api/suggest-replies — fast model proposes a few tappable canned replies
 * for the latest assistant message (the "glance but don't type/talk" affordance).
 */
export function createSuggestRepliesRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/suggest-replies', async (c) => {
        if (!isLlmConfigured()) return c.json({ error: 'LLM not configured (GEMINI_API_KEY)' }, 400)

        const json = await c.req.json().catch(() => null)
        const parsed = suggestSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        const transcript = parsed.data.messages
            .map((m) => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text}`)
            .join('\n')

        try {
            const raw = await callFastModel({
                system: SYSTEM,
                prompt: `Conversation so far:\n${transcript}\n\nReply options as a JSON array:`,
                maxTokens: 200
            })
            return c.json({ replies: parseReplies(raw) })
        } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : 'Suggest failed' }, 502)
        }
    })

    return app
}
