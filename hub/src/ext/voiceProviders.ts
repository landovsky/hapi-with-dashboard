/**
 * Provider-abstracted TTS / STT.
 *
 * The dashboard's voice surface deliberately bypasses HAPI's existing
 * `voice.ts`, which is built entirely around ElevenLabs ConvAI (a spawned
 * conversational agent). We want the dead-simple primitives instead:
 *   - TTS: text in → audio bytes out (read a finished Claude reply aloud)
 *   - STT: audio in → transcript text out (dictate, paste as-is into the session)
 *
 * Both are expressed as interfaces so a local provider (e.g. whisper.cpp for
 * STT, Piper/Kokoro for TTS) can drop in later by env switch with no route change.
 */

const ELEVENLABS_API_BASE = process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io/v1'

export interface TtsRequest {
    text: string
    voiceId?: string
    /** ElevenLabs model; multilingual_v2 handles Czech well. */
    modelId?: string
}

export interface TtsResult {
    audio: ArrayBuffer
    contentType: string
}

export interface SttRequest {
    audio: ArrayBuffer
    /** MIME of the uploaded audio, e.g. 'audio/webm', 'audio/mp4'. */
    contentType: string
    /** ISO-639 hint, e.g. 'cs'. Optional — Scribe auto-detects. */
    language?: string
}

export interface SttResult {
    text: string
    language?: string
}

export interface TtsProvider {
    readonly name: string
    synthesize(req: TtsRequest): Promise<TtsResult>
}

export interface SttProvider {
    readonly name: string
    transcribe(req: SttRequest): Promise<SttResult>
}

// ---- ElevenLabs implementations --------------------------------------------

/** A sensible Czech-capable default; override per call or via env. */
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_TTS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'
const DEFAULT_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2'
const DEFAULT_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1'

class ElevenLabsTts implements TtsProvider {
    readonly name = 'elevenlabs'
    constructor(private readonly apiKey: string) {}

    async synthesize(req: TtsRequest): Promise<TtsResult> {
        const voiceId = req.voiceId || DEFAULT_VOICE_ID
        const res = await fetch(`${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`, {
            method: 'POST',
            headers: {
                'xi-api-key': this.apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text: req.text,
                model_id: req.modelId || DEFAULT_TTS_MODEL
            })
        })
        if (!res.ok) {
            const detail = await res.text().catch(() => '')
            throw new Error(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 300)}`)
        }
        return { audio: await res.arrayBuffer(), contentType: 'audio/mpeg' }
    }
}

class ElevenLabsStt implements SttProvider {
    readonly name = 'elevenlabs'
    constructor(private readonly apiKey: string) {}

    async transcribe(req: SttRequest): Promise<SttResult> {
        const form = new FormData()
        form.append('model_id', DEFAULT_STT_MODEL)
        if (req.language) form.append('language_code', req.language)
        form.append('file', new Blob([req.audio], { type: req.contentType }), 'audio')

        const res = await fetch(`${ELEVENLABS_API_BASE}/speech-to-text`, {
            method: 'POST',
            headers: { 'xi-api-key': this.apiKey },
            body: form
        })
        if (!res.ok) {
            const detail = await res.text().catch(() => '')
            throw new Error(`ElevenLabs STT failed (${res.status}): ${detail.slice(0, 300)}`)
        }
        const data = await res.json() as { text?: string; language_code?: string }
        return { text: data.text ?? '', language: data.language_code }
    }
}

// ---- selection (env-switchable) --------------------------------------------

/** Returns the configured TTS provider, or null if no credentials are present. */
export function resolveTtsProvider(): TtsProvider | null {
    const backend = process.env.HAPI_TTS_BACKEND || 'elevenlabs'
    if (backend === 'elevenlabs') {
        const key = process.env.ELEVENLABS_API_KEY
        return key ? new ElevenLabsTts(key) : null
    }
    // Future: 'piper', 'kokoro', etc.
    return null
}

/** Returns the configured STT provider, or null if no credentials are present. */
export function resolveSttProvider(): SttProvider | null {
    const backend = process.env.HAPI_STT_BACKEND || 'elevenlabs'
    if (backend === 'elevenlabs') {
        const key = process.env.ELEVENLABS_API_KEY
        return key ? new ElevenLabsStt(key) : null
    }
    // Future: 'whisper-local', etc.
    return null
}
