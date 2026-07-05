import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { SessionSummary } from '@/types/api'

// jsdom has no layout engine, so scrollIntoView is undefined — the Jump handler
// calls it inside rAF. Stub it so revealing a tile doesn't throw under test.
beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn()
})

// vitest has no `context`; alias it to name the scenario, not the method.
const context = describe

// The board pulls sessions from this hook — feed it fixtures so the render
// exercises the real status derivation + grouping, not a stub.
const sessions: SessionSummary[] = []
vi.mock('@/hooks/queries/useDashboardSessions', () => ({
    useDashboardSessions: () => ({
        sessions,
        total: sessions.length,
        shown: sessions.length,
        days: 5,
        isLoading: false,
        error: null,
        refetch: vi.fn()
    })
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
            const { container } = render(<DashboardPage />)
            // The Projects tab opens collapsed; the flat Sessions tab always
            // shows every tile, so assert titles there.
            fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
            const titles = Array.from(container.querySelectorAll('.vd-ttl')).map((el) => el.textContent)
            expect(titles).toContain('blog-redesign')
            expect(titles).toContain('old-spike')
            // a thinking session reads as WORK, a crashed one as DEAD
            expect(screen.getByText('WORK')).toBeInTheDocument()
            expect(screen.getByText('DEAD')).toBeInTheDocument()
        })
    })

    context('operators think in projects, so the board should open already ordered by project, not one flat recency stream', () => {
        it('groups sessions under a distinct project header by default (#11, #12)', () => {
            setSessions([
                makeSummary({ id: 'a', metadata: { path: '/x/blog-redesign' } }),
                makeSummary({ id: 'b', metadata: { path: '/x/api-svc' } })
            ])
            const { container } = render(<DashboardPage />)
            const projNames = Array.from(container.querySelectorAll('.vd-projname')).map((el) => el.textContent)
            expect(projNames).toEqual(expect.arrayContaining(['blog-redesign', 'api-svc']))
        })

        it('offers a scrollable quick-jump pill per project, freshest first (#4)', () => {
            setSessions([
                makeSummary({ id: 'a', updatedAt: 100, metadata: { path: '/x/alpha' } }),
                makeSummary({ id: 'b', updatedAt: 200, metadata: { path: '/x/bravo' } })
            ])
            const { container } = render(<DashboardPage />)
            const pills = Array.from(container.querySelectorAll('.vd-pjpill-name')).map((el) => el.textContent)
            // bravo updated more recently than alpha, so its pill comes first.
            expect(pills).toEqual(['bravo', 'alpha'])
        })

        it('opens with every project collapsed and toggles a group when its header is tapped (#2, #3)', () => {
            setSessions([makeSummary({ id: 'a', metadata: { path: '/x/alpha' } })])
            const { container } = render(<DashboardPage />)
            const header = container.querySelector('.vd-projsec') as HTMLElement
            // Collapsed by default — the header shows but no tile does.
            expect(container.querySelector('.vd-tile')).toBeNull()
            fireEvent.click(header)
            expect(container.querySelector('.vd-tile')).toBeTruthy()
            fireEvent.click(header)
            expect(container.querySelector('.vd-tile')).toBeNull()
        })

        it('splits into Projects and Sessions tabs — the Sessions tab is a flat list with no project headers (#3)', () => {
            setSessions([makeSummary({ id: 'a', metadata: { path: '/x/alpha' } })])
            const { container } = render(<DashboardPage />)
            // Projects tab (default): a project header, no tiles (collapsed).
            expect(container.querySelector('.vd-projname')).toBeTruthy()
            fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
            // Sessions tab: flat — the tile shows, no project header.
            expect(container.querySelector('.vd-projname')).toBeNull()
            expect(container.querySelector('.vd-tile')).toBeTruthy()
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

        it('dismisses the pill once you jump — it should not stay stuck pulsing after you act on it', () => {
            setSessions([
                makeSummary({ id: 'c', metadata: { path: '/x/scrape-carvago' }, pendingRequestsCount: 1, pendingRequestKinds: ['input'] })
            ])
            render(<DashboardPage />)
            const pill = screen.getByText(/WAITING · scrape-carvago/)
            fireEvent.click(pill)
            expect(screen.queryByText(/WAITING · scrape-carvago/)).not.toBeInTheDocument()
        })
    })

    context('on desktop the operator reaches for ⌘F expecting to search sessions, not the browser find-on-page', () => {
        it('routes ⌘F / Ctrl+F focus into the board search input', () => {
            setSessions([makeSummary({ id: 'e', metadata: { path: '/x/blog' } })])
            render(<DashboardPage />)
            const input = screen.getByLabelText('Search sessions')
            expect(input).not.toHaveFocus()
            fireEvent.keyDown(window, { key: 'f', metaKey: true })
            expect(input).toHaveFocus()
        })
    })

    context('a finished session should be resolvable from its row — that is the point of the board', () => {
        it('exposes inline commit/PR quick-actions on a done row', () => {
            setSessions([
                makeSummary({ id: 'd', metadata: { path: '/x/auth-rate-limit' }, todoProgress: { completed: 3, total: 3 } })
            ])
            render(<DashboardPage />)
            // Tiles (and their quick-actions) live under the flat Sessions tab.
            fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
            expect(screen.getByText('DONE')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'commit' })).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'PR' })).toBeInTheDocument()
        })
    })

    context('an empty fleet should say so plainly, not render a broken shell', () => {
        it('shows the empty-window message (and nudges Show all) when nothing is recent', () => {
            setSessions([])
            render(<DashboardPage />)
            expect(screen.getByText(/Nothing in the last 5 days/)).toBeInTheDocument()
        })
    })
})
