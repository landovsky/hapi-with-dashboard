import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useSessions } from '@/hooks/queries/useSessions'
import { useMessages } from '@/hooks/queries/useMessages'
import { useAudioRecorder } from '@/hooks/useAudioRecorder'
import { extractLastAssistantSpeakableDetailed, VOICE_PREAMBLE } from '@/realtime/hooks/contextFormatters'
import {
    DASHBOARD_STATUS_META,
    dashboardSessionTitle,
    deriveDashboardStatus
} from '@/lib/dashboardStatus'
import type { VoiceTranscriptMessage } from '@/types/dashboard'
import { LoadingState } from '@/components/LoadingState'
import './voice.css'

/** While the voice view is open we nudge the message query so a reply that
 *  arrives over SSE (or not) still surfaces promptly to be read aloud. */
const REPLY_POLL_MS = 5_000

type MicPhase = 'idle' | 'listening' | 'sending'

/** A visible bubble — the transcript shape plus when it happened, so the view
 *  can show how old each message is (the API-facing shape stays role+text). */
type Bubble = VoiceTranscriptMessage & { at?: number }

/** Compact "how long ago" for a message, self-contained so the voice surface
 *  needs no i18n provider. Falls back to a date once it's older than a week. */
function relativeAge(at: number): string {
    const delta = Date.now() - at
    if (delta < 60_000) return 'just now'
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d ago`
    return new Date(at).toLocaleDateString()
}

export default function VoicePage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { sessionId } = useParams({ from: '/voice/$sessionId' })
    const { mic: micRequested } = useSearch({ from: '/voice/$sessionId' })
    const { sessions } = useSessions(api)
    const { messages, isLoading, refetch } = useMessages(api, sessionId)
    const recorder = useAudioRecorder()

    const [bubbles, setBubbles] = useState<Bubble[]>([])
    const [suggestions, setSuggestions] = useState<string[]>([])
    const [sending, setSending] = useState(false)
    const [speaking, setSpeaking] = useState(false)
    const [copiedKey, setCopiedKey] = useState<string | null>(null)
    const [hint, setHint] = useState<string | null>(null)

    const audioRef = useRef<HTMLAudioElement | null>(null)
    // Highest assistant seq we've auto-spoken this mount. Tracking by seq (not
    // text) means a reply read once is never re-read, even if the same words
    // recur. Seeded from the persisted server mark below so re-entry/refresh
    // doesn't replay (and re-bill) what an earlier visit already spoke.
    const spokenSeqRef = useRef<number>(-1)
    // Last assistant seq we fetched tappable replies for. Suggestions hit the
    // cheap fast model (not ElevenLabs), so they load for any new reply — the
    // credit-sensitive gating applies only to TTS.
    const suggestedSeqRef = useRef<number>(-1)
    // null = server's tts-state not loaded yet; we hold off auto-TTS until then
    // so the first render after mount can't fire on an already-played reply.
    const [playedSeq, setPlayedSeq] = useState<number | null>(null)

    const summary = useMemo(() => sessions.find((s) => s.id === sessionId) ?? null, [sessions, sessionId])
    const title = summary ? dashboardSessionTitle(summary) : sessionId.slice(0, 8)
    const status = summary ? deriveDashboardStatus(summary, { lastSeenAt: 0, now: Date.now() }) : null
    const statusMeta = status ? DASHBOARD_STATUS_META[status] : null

    const lastReply = useMemo(() => extractLastAssistantSpeakableDetailed(messages), [messages])
    const lastAssistant = lastReply?.text ?? null

    // Load the durable "already read aloud" mark for this session before any
    // auto-TTS can run. On failure (older hub without the route) fall back to
    // -1 so voice replies still get spoken — spokenSeqRef still de-dupes within
    // the mount; we just lose cross-mount suppression.
    useEffect(() => {
        let cancelled = false
        setPlayedSeq(null)
        spokenSeqRef.current = -1
        if (!api) {
            return
        }
        api.getTtsState()
            .then(({ ttsState }) => { if (!cancelled) setPlayedSeq(ttsState[sessionId] ?? -1) })
            .catch(() => { if (!cancelled) setPlayedSeq(-1) })
        return () => { cancelled = true }
    }, [api, sessionId])

    // Serialize TTS so the voice view never fires concurrent ElevenLabs
    // requests. Their low-tier concurrency cap is what turned bursts (auto-read
    // a reply, then tap replay/summarize) into 502s. Each call chains behind the
    // previous synth+playback; a newer call supersedes any still-pending one
    // (latest reply wins) and stops whatever is currently playing.
    const ttsChainRef = useRef<Promise<void>>(Promise.resolve())
    const ttsTokenRef = useRef(0)
    // `mark` is passed only on the auto-read path so a successful synth records
    // the reply as played server-side; replay/summarize omit it.
    const playTts = useCallback((text: string, mark?: { sessionId: string; seq: number }): Promise<void> => {
        if (!api || !text.trim()) {
            return Promise.resolve()
        }
        const token = ++ttsTokenRef.current
        audioRef.current?.pause()
        setSpeaking(false)
        const next = ttsChainRef.current.catch(() => {}).then(async () => {
            if (token !== ttsTokenRef.current) {
                return // superseded before our turn — skip the network call entirely
            }
            try {
                const blob = await api.synthesizeSpeech(text, undefined, mark)
                if (token !== ttsTokenRef.current) {
                    return
                }
                const url = URL.createObjectURL(blob)
                if (!audioRef.current) {
                    audioRef.current = new Audio()
                }
                const el = audioRef.current
                el.src = url
                setSpeaking(true)
                await new Promise<void>((resolve) => {
                    el.onended = () => { URL.revokeObjectURL(url); resolve() }
                    el.onerror = () => { URL.revokeObjectURL(url); resolve() }
                    el.play().catch(() => resolve())
                })
            } catch {
                // Autoplay can be blocked until a user gesture; Replay is the fallback.
            } finally {
                if (token === ttsTokenRef.current) {
                    setSpeaking(false)
                }
            }
        })
        ttsChainRef.current = next
        return next
    }, [api])

    // Stop whatever's being read aloud — auto-read, replay, or summarize (#32).
    // Bumping the token makes any still-pending synth in the chain self-cancel
    // (it sees token !== current and bails before playing); pausing kills the
    // audio that's already sounding.
    const stopTts = useCallback(() => {
        ttsTokenRef.current += 1
        audioRef.current?.pause()
        setSpeaking(false)
    }, [])

    const loadSuggestions = useCallback(async (assistantText: string) => {
        if (!api || !assistantText.trim()) {
            return
        }
        try {
            const { replies } = await api.suggestReplies([{ role: 'assistant', text: assistantText }])
            setSuggestions(replies)
        } catch {
            setSuggestions([])
        }
    }, [api])

    // Reconcile the latest assistant message into the visible exchange, and —
    // when it's a genuinely new VOICE reply — read it aloud and refresh the
    // tappable replies. Two guards keep us off the ElevenLabs meter:
    //  - voiceOriginated: never auto-read an ordinary chat reply (often long and
    //    never meant to be spoken); those still show as a bubble with manual ↺.
    //  - seq > played marks: skip anything an earlier visit already spoke. We
    //    wait for the server mark (playedSeq !== null) before deciding.
    useEffect(() => {
        if (!lastReply) {
            return
        }
        const { text, seq, createdAt, voiceOriginated } = lastReply
        setBubbles((prev) =>
            prev.some((b) => b.role === 'assistant' && b.text === text)
                ? prev
                : [...prev, { role: 'assistant', text, at: createdAt || undefined }]
        )
        if (suggestedSeqRef.current !== seq) {
            suggestedSeqRef.current = seq
            void loadSuggestions(text)
        }
        if (playedSeq === null || !voiceOriginated) {
            return
        }
        if (seq <= playedSeq || seq <= spokenSeqRef.current) {
            return
        }
        spokenSeqRef.current = seq
        void playTts(text, { sessionId, seq })
    }, [lastReply, playedSeq, sessionId, playTts, loadSuggestions])

    // Keep messages fresh while the view is open so a reply surfaces to be spoken.
    useEffect(() => {
        const id = setInterval(() => { void refetch() }, REPLY_POLL_MS)
        return () => clearInterval(id)
    }, [refetch])

    useEffect(() => () => { audioRef.current?.pause() }, [])

    // Arrived with mic=true (from "Reply by voice") — arm the recorder once. The
    // navigating tap is still within the user-activation window, so getUserMedia
    // is allowed; if it isn't, the mic button stays the fallback. Guarded so it
    // fires a single time even as recorder state churns.
    const micArmedRef = useRef(false)
    useEffect(() => {
        if (!micRequested || micArmedRef.current || recorder.state !== 'idle') {
            return
        }
        micArmedRef.current = true
        void recorder.start()
    }, [micRequested, recorder.state, recorder.start])

    const sendUserText = useCallback(async (text: string) => {
        const trimmed = text.trim()
        if (!api || !trimmed) {
            return
        }
        setHint(null)
        setSuggestions([])
        setBubbles((prev) => [...prev, { role: 'user', text: trimmed, at: Date.now() }])
        try {
            await api.sendMessage(sessionId, `${VOICE_PREAMBLE}\n\n${trimmed}`)
        } catch {
            setHint('Send failed — the session may be inactive.')
        }
    }, [api, sessionId])

    const onMicTap = useCallback(async () => {
        if (recorder.state === 'unsupported' || recorder.state === 'denied') {
            setHint('Microphone unavailable on this device.')
            return
        }
        if (recorder.state === 'recording') {
            setSending(true)
            try {
                const blob = await recorder.stop()
                if (blob && api) {
                    const { text } = await api.transcribeSpeech(blob, 'cs')
                    if (text?.trim()) {
                        await sendUserText(text)
                    } else {
                        setHint("Didn't catch that — try again.")
                    }
                }
            } catch {
                setHint("Couldn't transcribe — try again.")
            } finally {
                setSending(false)
            }
        } else {
            await recorder.start()
        }
    }, [recorder, api, sendUserText])

    const onSummarize = useCallback(async () => {
        if (!api) {
            return
        }
        const transcript: VoiceTranscriptMessage[] = bubbles.length
            ? bubbles.map((b) => ({ role: b.role, text: b.text }))
            : lastAssistant
                ? [{ role: 'assistant' as const, text: lastAssistant }]
                : []
        if (!transcript.length) {
            return
        }
        try {
            const { summary: recap } = await api.summarizeSession(transcript, title)
            await playTts(recap)
        } catch {
            setHint('Summary unavailable.')
        }
    }, [api, bubbles, lastAssistant, title, playTts])

    const phase: MicPhase = sending ? 'sending' : recorder.state === 'recording' ? 'listening' : 'idle'
    // Idle needs no caption — the mic glyph is self-explanatory (#31). The
    // listening/sending states keep their captions since they convey progress.
    const micHint = phase === 'sending'
        ? 'sending · fire & forget ✓'
        : phase === 'listening'
            ? 'listening — tap to send'
            : ''

    const goBack = useCallback(() => navigate({ to: '/dashboard' }), [navigate])
    // Jump straight to the full session view — the voice surface is a lens, not a
    // dead end.
    const openDetail = useCallback(
        () => navigate({ to: '/sessions/$sessionId', params: { sessionId } }),
        [navigate, sessionId]
    )
    const copyMessage = useCallback((text: string, key: string) => {
        void navigator.clipboard?.writeText(text).then(() => {
            setCopiedKey(key)
            setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500)
        }).catch(() => { /* clipboard blocked — best-effort */ })
    }, [])

    return (
        <div className="vv">
            <div className="vv-top">
                <button type="button" className="vv-back" onClick={goBack} aria-label="Back to dashboard">‹</button>
                <span className="vv-name">{title}</span>
                <button type="button" className="vv-open" onClick={openDetail} aria-label="Open session detail" title="Open session detail">↗</button>
                {statusMeta ? (
                    <span className="vv-stat" style={{ background: statusMeta.soft, color: statusMeta.chipText }}>
                        <span aria-hidden>{statusMeta.icon}</span>
                        {statusMeta.label}
                    </span>
                ) : null}
            </div>

            <div className="vv-convo">
                {isLoading && bubbles.length === 0 ? (
                    <LoadingState label="Loading conversation…" className="text-sm" />
                ) : null}
                {bubbles.map((b, i) => {
                    const key = `${b.role}-${i}`
                    const when = b.at ? relativeAge(b.at) : null
                    return (
                    <div key={key} className={`vv-bubble ${b.role === 'user' ? 'vv-you' : 'vv-claude'}`}>
                        <div className="vv-label">
                            <span>{b.role === 'user' ? 'You' : 'Zorka · Claude'}</span>
                            {when ? <span className="vv-time">· {when}</span> : null}
                            <button
                                type="button"
                                className="vv-copy"
                                onClick={() => copyMessage(b.text, key)}
                                aria-label="Copy message"
                                title="Copy message"
                            >{copiedKey === key ? '✓ copied' : '⧉ copy'}</button>
                        </div>
                        {b.text}
                        {b.role === 'assistant' && i === bubbles.length - 1 ? (
                            <div className="vv-speakbar">
                                {speaking ? (
                                    <>
                                        <div className="vv-wave">
                                            <span /><span /><span /><span /><span /><span />
                                        </div>
                                        <span className="vv-spk-txt">reading aloud…</span>
                                        <button type="button" className="vv-stop" onClick={() => stopTts()}>⏹ stop</button>
                                    </>
                                ) : (
                                    <button type="button" className="vv-replay" onClick={() => void playTts(b.text)}>↺ replay</button>
                                )}
                            </div>
                        ) : null}
                    </div>
                    )
                })}
            </div>

            {hint ? <div className="vv-error">{hint}</div> : null}

            {suggestions.length > 0 && phase === 'idle' ? (
                <div className="vv-chips">
                    {suggestions.map((s, i) => (
                        <button key={i} type="button" className="vv-sg" onClick={() => void sendUserText(s)}>{s}</button>
                    ))}
                </div>
            ) : null}

            <button type="button" className="vv-summarize" onClick={() => void onSummarize()} disabled={speaking}>
                ✦ summarize this session aloud
            </button>

            <div className="vv-mic-dock">
                {phase === 'listening' ? (
                    <div className="vv-mic-live-wave">
                        <span /><span /><span /><span /><span /><span /><span />
                    </div>
                ) : null}
                {phase === 'sending' ? <div className="vv-spinner" /> : null}
                <button
                    type="button"
                    className={`vv-mic-btn${phase === 'listening' ? ' vv-listening' : ''}${phase === 'sending' ? ' vv-sending' : ''}`}
                    onClick={() => void onMicTap()}
                    disabled={phase === 'sending'}
                    aria-label={phase === 'listening' ? 'Stop recording and send' : phase === 'sending' ? 'Sending' : 'Record a voice message'}
                >
                    🎙
                </button>
                {micHint ? <div className="vv-mic-hint">{micHint}</div> : null}
            </div>
        </div>
    )
}
