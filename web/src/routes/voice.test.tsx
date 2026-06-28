import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import type { SessionSummary } from '@/types/api'

const context = describe

const navigate = vi.fn()
const recorder = { state: 'idle' as const, start: vi.fn(), stop: vi.fn(), error: null }
const api = {
    // rejects so playTts bails before touching Audio/createObjectURL (absent in jsdom)
    synthesizeSpeech: vi.fn().mockRejectedValue(new Error('no audio in test')),
    suggestReplies: vi.fn().mockResolvedValue({ replies: ['Wire them in', 'Hold for review'] }),
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
    effort: null
}]

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigate,
    useParams: () => ({ sessionId: 's1' })
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
    extractLastAssistantSpeakable: () => 'Want me to wire the tokens in, or hold for review?'
}))

import VoicePage from './voice'

afterEach(cleanup)

describe('VoicePage', () => {
    context('the voice surface has to turn the last reply into something you can hear and answer, without crashing', () => {
        it('seeds the latest assistant reply as a Claude bubble with its header and name', () => {
            render(<VoicePage />)
            expect(screen.getByText('blog-redesign')).toBeInTheDocument()
            expect(screen.getByText('Zorka · Claude')).toBeInTheDocument()
            expect(screen.getByText(/Want me to wire the tokens in/)).toBeInTheDocument()
        })

        it('offers the always-available controls — summarize aloud and a tap-to-talk mic', () => {
            render(<VoicePage />)
            expect(screen.getByText(/summarize this session aloud/)).toBeInTheDocument()
            expect(screen.getByText('tap to talk')).toBeInTheDocument()
        })

        it('surfaces tappable suggested replies once the model proposes them', async () => {
            render(<VoicePage />)
            await waitFor(() => expect(screen.getByText('Wire them in')).toBeInTheDocument())
            expect(screen.getByText('Hold for review')).toBeInTheDocument()
        })
    })
})
