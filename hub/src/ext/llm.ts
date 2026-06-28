/**
 * Minimal fast-model client for the dashboard's side features:
 *   - summarize: "catch me up" recap of the last N messages
 *   - suggest-replies: 3–4 short tappable replies for the latest assistant message
 *
 * Both are latency-sensitive, cheap, throwaway calls — so they use Gemini Flash
 * via the Generative Language REST API directly (no SDK added to the hub).
 * Wrapped behind `callFastModel()` so the provider/model can be swapped centrally.
 *
 * Uses GEMINI_API_KEY / GOOGLE_API_KEY — the same convention upstream's voice.ts
 * already uses, so no new secret type is introduced (just add the value to the
 * k3s `hapi-hub-secrets`).
 */

const GEMINI_API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta'
const FAST_MODEL = process.env.HAPI_FAST_MODEL || 'gemini-2.0-flash'

export interface FastModelRequest {
    system: string
    prompt: string
    maxTokens?: number
}

export class LlmNotConfiguredError extends Error {
    constructor() {
        super('GEMINI_API_KEY not configured')
        this.name = 'LlmNotConfiguredError'
    }
}

function geminiKey(): string | undefined {
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
}

export function isLlmConfigured(): boolean {
    return Boolean(geminiKey())
}

export async function callFastModel(req: FastModelRequest): Promise<string> {
    const apiKey = geminiKey()
    if (!apiKey) throw new LlmNotConfiguredError()

    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(FAST_MODEL)}:generateContent`
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'x-goog-api-key': apiKey,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: req.system }] },
            contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
            generationConfig: { maxOutputTokens: req.maxTokens ?? 512 }
        })
    })
    if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Gemini call failed (${res.status}): ${detail.slice(0, 300)}`)
    }
    const data = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    return (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim()
}
