import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useSessions } from '@/hooks/queries/useSessions'
import { useMessages } from '@/hooks/queries/useMessages'
import { useAudioRecorder } from '@/hooks/useAudioRecorder'
import { extractLastAssistantSpeakable } from '@/realtime/hooks/contextFormatters'
import {
    DASHBOARD_STATUS_META,
    dashboardSessionTitle,
    deriveDashboardStatus
} from '@/lib/dashboardStatus'
import type { VoiceTranscriptMessage } from '@/types/dashboard'
import { LoadingState } from '@/components/LoadingState'
import './voice.css'

/** One-line hat on voice-originated messages so replies come back short and
 *  speakable, without a per-session flag or a modified system prompt. */
const VOICE_PREAMBLE = '[Voice mode — keep your reply short and speakable.]'

/** While the voice view is open we nudge the message query so a reply that
 *  arrives over SSE (or not) still surfaces promptly to be read aloud. */
const REPLY_POLL_MS = 5_000

type MicPhase = 'idle' | 'listening' | 'sending'

export default function VoicePage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { sessionId } = useParams({ from: '/voice/$sessionId' })
    const { sessions } = useSessions(api)
    const { messages, isLoading, refetch } = useMessages(api, sessionId)
    const recorder = useAudioRecorder()

    const [bubbles, setBubbles] = useState<VoiceTranscriptMessage[]>([])
    const [suggestions, setSuggestions] = useState<string[]>([])
    const [sending, setSending] = useState(false)
    const [speaking, setSpeaking] = useState(false)
    const [hint, setHint] = useState<string | null>(null)

    const audioRef = useRef<HTMLAudioElement | null>(null)
    const spokenRef = useRef<string | null>(null)

    const summary = useMemo(() => sessions.find((s) => s.id === sessionId) ?? null, [sessions, sessionId])
    const title = summary ? dashboardSessionTitle(summary) : sessionId.slice(0, 8)
    const status = summary ? deriveDashboardStatus(summary, { lastSeenAt: 0, now: Date.now() }) : null
    const statusMeta = status ? DASHBOARD_STATUS_META[status] : null

    const lastAssistant = useMemo(() => extractLastAssistantSpeakable(messages), [messages])

    // Serialize TTS so the voice view never fires concurrent ElevenLabs
    // requests. Their low-tier concurrency cap is what turned bursts (auto-read
    // a reply, then tap replay/summarize) into 502s. Each call chains behind the
    // previous synth+playback; a newer call supersedes any still-pending one
    // (latest reply wins) and stops whatever is currently playing.
    const ttsChainRef = useRef<Promise<void>>(Promise.resolve())
    const ttsTokenRef = useRef(0)
    const playTts = useCallback((text: string): Promise<void> => {
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
                const blob = await api.synthesizeSpeech(text)
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
    // when it's genuinely new — read it aloud and refresh the tappable replies.
    // Seeding (first load) and later replies go through the same path.
    useEffect(() => {
        if (!lastAssistant) {
            return
        }
        setBubbles((prev) =>
            prev.some((b) => b.role === 'assistant' && b.text === lastAssistant)
                ? prev
                : [...prev, { role: 'assistant', text: lastAssistant }]
        )
        if (spokenRef.current !== lastAssistant) {
            spokenRef.current = lastAssistant
            void playTts(lastAssistant)
            void loadSuggestions(lastAssistant)
        }
    }, [lastAssistant, playTts, loadSuggestions])

    // Keep messages fresh while the view is open so a reply surfaces to be spoken.
    useEffect(() => {
        const id = setInterval(() => { void refetch() }, REPLY_POLL_MS)
        return () => clearInterval(id)
    }, [refetch])

    useEffect(() => () => { audioRef.current?.pause() }, [])

    const sendUserText = useCallback(async (text: string) => {
        const trimmed = text.trim()
        if (!api || !trimmed) {
            return
        }
        setHint(null)
        setSuggestions([])
        setBubbles((prev) => [...prev, { role: 'user', text: trimmed }])
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
        const transcript = bubbles.length
            ? bubbles
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
    const micHint = phase === 'sending'
        ? 'sending · fire & forget ✓'
        : phase === 'listening'
            ? 'listening — tap to send'
            : 'tap to talk'

    const goBack = useCallback(() => navigate({ to: '/dashboard' }), [navigate])

    return (
        <div className="vv">
            <div className="vv-top">
                <button type="button" className="vv-back" onClick={goBack} aria-label="Back to dashboard">‹</button>
                <span className="vv-name">{title}</span>
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
                {bubbles.map((b, i) => (
                    <div key={`${b.role}-${i}`} className={`vv-bubble ${b.role === 'user' ? 'vv-you' : 'vv-claude'}`}>
                        <div className="vv-label">{b.role === 'user' ? 'You' : 'Zorka · Claude'}</div>
                        {b.text}
                        {b.role === 'assistant' && i === bubbles.length - 1 ? (
                            <div className="vv-speakbar">
                                {speaking ? (
                                    <>
                                        <div className="vv-wave">
                                            <span /><span /><span /><span /><span /><span />
                                        </div>
                                        <span className="vv-spk-txt">reading aloud…</span>
                                    </>
                                ) : null}
                                <button type="button" className="vv-replay" onClick={() => void playTts(b.text)}>↺ replay</button>
                            </div>
                        ) : null}
                    </div>
                ))}
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
                    aria-label={micHint}
                >
                    🎙
                </button>
                <div className="vv-mic-hint">{micHint}</div>
            </div>
        </div>
    )
}
