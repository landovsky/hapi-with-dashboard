import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import type { SessionSummary } from '@/types/api'

// jsdom has no <audio> or object URLs. Stub just enough that playTts can reach
// the "playing" state (so the Stop control renders) without real media. play()
// never resolves, so playback stays "in progress" until stop() supersedes it.
beforeAll(() => {
    class FakeAudio {
        play = vi.fn(() => new Promise<void>(() => {}))
        pause = vi.fn()
        src = ''
        onended: (() => void) | null = null
        onerror: (() => void) | null = null
    }
    globalThis.Audio = FakeAudio as unknown as typeof Audio
    globalThis.URL.createObjectURL = () => 'blob:voice-test'
    globalThis.URL.revokeObjectURL = () => {}
    // jsdom has no clipboard — stub writeText so the copy button is testable.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true
    })
})

const context = describe

const navigate = vi.fn()
const recorder = { state: 'idle' as const, start: vi.fn(), stop: vi.fn(), error: null }
// Mutable so a test can simulate arriving with ?mic=true (the "Reply by voice"
// intent) while every other test sees the default no-mic search.
let searchParams: { mic?: true } = {}
const api = {
    // rejects so playTts bails before touching Audio/createObjectURL (absent in jsdom)
    synthesizeSpeech: vi.fn().mockRejectedValue(new Error('no audio in test')),
    suggestReplies: vi.fn().mockResolvedValue({ replies: ['Wire them in', 'Hold for review'] }),
    // nothing spoken yet for this session — exercises the auto-read decision path
    getTtsState: vi.fn().mockResolvedValue({ ttsState: {} }),
    summarizeSession: vi.fn(),
    transcribeSpeech: vi.fn(),
    sendMessage: vi.fn()
}

const sessions: SessionSummary[] = [{
    id: 's1',
    active: true,
    thinking: true,
    activeAt: Date.now(),
    updatedAt: Date.now(),
    metadata: { path: '/home/tomas/git/blog-redesign' },
    todoProgress: null,
    pendingRequestsCount: 0,
    pendingRequestKinds: [],
    pendingRequests: [],
    backgroundTaskCount: 0,
    futureScheduledMessageCount: 0,
    nextScheduledAt: null,
    model: null,
    effort: null,
    metadataVersion: 0,
    agentStateVersion: 0,
    todosUpdatedAt: 0
}]

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigate,
    useParams: () => ({ sessionId: 's1' }),
    useSearch: () => searchParams
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api }) }))
vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions, isLoading: false, error: null, refetch: vi.fn() })
}))
vi.mock('@/hooks/queries/useMessages', () => ({
    useMessages: () => ({ messages: [], isLoading: false, refetch: vi.fn() })
}))
vi.mock('@/hooks/useAudioRecorder', () => ({ useAudioRecorder: () => recorder }))
vi.mock('@/realtime/hooks/contextFormatters', () => ({
    VOICE_PREAMBLE: '[Voice mode — keep your reply short and speakable.]',
    // voiceOriginated reply so the surface seeds it, loads suggestions, and
    // exercises the auto-read path (synthesizeSpeech rejects, so no real audio)
    extractLastAssistantSpeakableDetailed: () => ({
        text: 'Want me to wire the tokens in, or hold for review?',
        seq: 1,
        createdAt: Date.now() - 5 * 60_000,
        voiceOriginated: true
    })
}))

import VoicePage from './voice'

beforeEach(() => {
    searchParams = {}
    recorder.start.mockClear()
})
afterEach(cleanup)

describe('VoicePage', () => {
    context('the voice surface has to turn the last reply into something you can hear and answer, without crashing', () => {
        it('seeds the latest assistant reply as a Claude bubble with its header and name', () => {
            render(<VoicePage />)
            expect(screen.getByText('blog-redesign')).toBeInTheDocument()
            expect(screen.getByText('Zorka · Claude')).toBeInTheDocument()
            expect(screen.getByText(/Want me to wire the tokens in/)).toBeInTheDocument()
        })

        it('offers summarize-aloud and a self-explanatory mic — no redundant "tap to talk" caption (#31)', () => {
            render(<VoicePage />)
            expect(screen.getByText(/summarize this session aloud/)).toBeInTheDocument()
            // The idle caption is gone; the mic is reachable by its stable label.
            expect(screen.queryByText('tap to talk')).not.toBeInTheDocument()
            expect(screen.getByLabelText('Record a voice message')).toBeInTheDocument()
        })

        it('surfaces tappable suggested replies once the model proposes them', async () => {
            render(<VoicePage />)
            await waitFor(() => expect(screen.getByText('Wire them in')).toBeInTheDocument())
            expect(screen.getByText('Hold for review')).toBeInTheDocument()
        })

        it('shows how old a message is so you can tell stale replies at a glance', () => {
            render(<VoicePage />)
            expect(screen.getByText(/5m ago/)).toBeInTheDocument()
        })

        it('lets you open the full session detail — the voice view is a lens, not a dead end', () => {
            render(<VoicePage />)
            fireEvent.click(screen.getByLabelText('Open session detail'))
            expect(navigate).toHaveBeenCalledWith({ to: '/sessions/$sessionId', params: { sessionId: 's1' } })
        })

        it('copies a message to the clipboard when its copy button is tapped', () => {
            render(<VoicePage />)
            fireEvent.click(screen.getByLabelText('Copy message'))
            expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Want me to wire the tokens in, or hold for review?')
        })
    })

    context('a reply reading itself aloud must be interruptible — the operator needs a way to shut it up (#32)', () => {
        it('shows a stop control while playing and halts playback when tapped', async () => {
            // Let this session's auto-read actually reach playback (default mock
            // rejects); once playing, the Stop control must appear.
            api.synthesizeSpeech.mockResolvedValueOnce(new Blob(['x']))
            render(<VoicePage />)
            const stop = await screen.findByText('⏹ stop')
            expect(stop).toBeInTheDocument()
            fireEvent.click(stop)
            // Tapping stop returns the bar to its idle "replay" affordance.
            await waitFor(() => expect(screen.queryByText('⏹ stop')).not.toBeInTheDocument())
            expect(screen.getByText('↺ replay')).toBeInTheDocument()
        })
    })

    context('"Reply by voice" is an explicit intent to speak — arriving with the mic already live spares a second tap (#23)', () => {
        it('arms the recorder on mount when navigated with mic=true', () => {
            searchParams = { mic: true }
            render(<VoicePage />)
            expect(recorder.start).toHaveBeenCalledTimes(1)
        })

        it('does not touch the mic on an ordinary voice-view open', () => {
            searchParams = {}
            render(<VoicePage />)
            expect(recorder.start).not.toHaveBeenCalled()
        })
    })
})
