import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { SessionSummary } from '@/types/api'

// vitest has no `context`; alias it to name the scenario, not the method.
const context = describe

// The board pulls sessions from this hook — feed it fixtures so the render
// exercises the real status derivation + grouping, not a stub.
const sessions: SessionSummary[] = []
vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions, isLoading: false, error: null, refetch: vi.fn() })
}))
// Pins / read-state ride on react-query inside the component; stub the query
// layer so no network is attempted and nothing is pinned by default.
vi.mock('@tanstack/react-query', () => ({
    useQuery: () => ({ data: undefined }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() })
}))
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn()
}))
vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {} })
}))

import DashboardPage from './dashboard'

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'sess-1',
        active: true,
        thinking: false,
        activeAt: Date.now(),
        updatedAt: Date.now(),
        metadata: { path: '/home/tomas/git/example' },
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

function setSessions(next: SessionSummary[]): void {
    sessions.length = 0
    sessions.push(...next)
}

afterEach(cleanup)

describe('DashboardPage', () => {
    context('the board has to translate live sessions into a glanceable triage grid without crashing', () => {
        it('renders one row per session with its derived status chip and title', () => {
            setSessions([
                makeSummary({ id: 'a', metadata: { path: '/x/blog-redesign' }, thinking: true }),
                // dead = inactive with an abnormal-exit lifecycle
                makeSummary({ id: 'b', active: false, metadata: { path: '/x/old-spike', lifecycleState: 'exited:error' } })
            ])
            render(<DashboardPage />)
            // titles come from the working-directory basename
            expect(screen.getByText('blog-redesign')).toBeInTheDocument()
            expect(screen.getByText('old-spike')).toBeInTheDocument()
            // a thinking session reads as WORK, a crashed one as DEAD
            expect(screen.getByText('WORK')).toBeInTheDocument()
            expect(screen.getByText('DEAD')).toBeInTheDocument()
        })
    })

    context('a blocking session must be impossible to miss — the off-screen waiting pill jumps you to it', () => {
        it('surfaces the waiting pill naming the session that needs a decision', () => {
            setSessions([
                makeSummary({ id: 'c', metadata: { path: '/x/scrape-carvago' }, pendingRequestsCount: 1, pendingRequestKinds: ['input'] })
            ])
            render(<DashboardPage />)
            expect(screen.getByText(/WAITING · scrape-carvago/)).toBeInTheDocument()
        })
    })

    context('a finished session should be resolvable from its row — that is the point of the board', () => {
        it('exposes inline commit/PR quick-actions on a done row', () => {
            setSessions([
                makeSummary({ id: 'd', metadata: { path: '/x/auth-rate-limit' }, todoProgress: { completed: 3, total: 3 } })
            ])
            render(<DashboardPage />)
            expect(screen.getByText('DONE')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'commit' })).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'PR' })).toBeInTheDocument()
        })
    })

    context('an empty fleet should say so plainly, not render a broken shell', () => {
        it('shows the no-sessions message when there is nothing live', () => {
            setSessions([])
            render(<DashboardPage />)
            expect(screen.getByText('No live sessions.')).toBeInTheDocument()
        })
    })
})
