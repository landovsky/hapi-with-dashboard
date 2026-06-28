import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    DASHBOARD_STATUS_META,
    dashboardSessionTitle,
    deriveDashboardStatus,
    formatElapsed
} from './dashboardStatus'

// vitest has no `context`; alias it so tests can name the real-world scenario
// that motivated each behaviour rather than the method under test.
const context = describe

const NOW = 1_700_000_000_000

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'sess-abcdef123456',
        active: true,
        thinking: false,
        activeAt: NOW,
        updatedAt: NOW,
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
        ...overrides
    }
}

describe('deriveDashboardStatus', () => {
    context("a blocking question is the only state that strictly needs you — it must outrank every other signal", () => {
        it('reads as waiting when a request is open even while the agent still looks busy', () => {
            const summary = makeSummary({
                thinking: true,
                pendingRequestsCount: 1,
                pendingRequestKinds: ['input']
            })
            expect(deriveDashboardStatus(summary, { lastSeenAt: 0, now: NOW })).toBe('waiting')
        })
    })

    context('a long-running agent must surface as working with its elapsed clock so it cannot hide (a 4h+ session was once found by accident)', () => {
        it('reads as working whenever the agent is thinking', () => {
            const summary = makeSummary({ thinking: true, activeAt: NOW - 4 * 60 * 60 * 1000 })
            expect(deriveDashboardStatus(summary, { lastSeenAt: 0, now: NOW })).toBe('working')
        })

        it('flags the clock amber once a working session passes an hour', () => {
            const summary = makeSummary({ thinking: true, activeAt: NOW - (4 * 60 + 12) * 60 * 1000 })
            const elapsed = formatElapsed(summary, 'working', NOW)
            expect(elapsed.text).toBe('4h12m')
            expect(elapsed.warnLong).toBe(true)
        })

        it('leaves a short working session un-flagged so the board is not a wall of amber', () => {
            const summary = makeSummary({ thinking: true, activeAt: NOW - 3 * 60 * 1000 })
            expect(formatElapsed(summary, 'working', NOW).warnLong).toBe(false)
        })
    })

    context('a session that exited badly must read as dead, not be mistaken for merely idle', () => {
        it('reads dead when an inactive session carries an error/exit lifecycle', () => {
            const summary = makeSummary({ active: false, metadata: { path: '/x', lifecycleState: 'exited:error' } })
            expect(deriveDashboardStatus(summary, { lastSeenAt: 0, now: NOW })).toBe('dead')
        })

        it('a clean inactive session with nothing finished is idle, not dead', () => {
            const summary = makeSummary({ active: false, metadata: { path: '/x', lifecycleState: 'stopped' } })
            expect(deriveDashboardStatus(summary, { lastSeenAt: 0, now: NOW })).toBe('idle')
        })
    })

    context('done means it finished the thing — separated from review so a completed task resolves without ever opening it', () => {
        it('reads done when the agent checked off its entire todo list', () => {
            const summary = makeSummary({ todoProgress: { completed: 5, total: 5 } })
            expect(deriveDashboardStatus(summary, { lastSeenAt: 0, now: NOW })).toBe('done')
        })

        it('reads review when there is fresh output but no completed plan to act on', () => {
            const summary = makeSummary({ updatedAt: NOW, todoProgress: { completed: 1, total: 5 } })
            expect(deriveDashboardStatus(summary, { lastSeenAt: NOW - 1000, now: NOW })).toBe('review')
        })
    })

    context('idle is the quiet floor — alive, nothing new, nothing finished — and must not raise a false unread', () => {
        it('reads idle once the operator has already seen the latest update', () => {
            const summary = makeSummary({ updatedAt: NOW - 5000 })
            expect(deriveDashboardStatus(summary, { lastSeenAt: NOW, now: NOW })).toBe('idle')
        })
    })
})

describe('dashboardSessionTitle', () => {
    context('a row needs a stable human label even when the session was never named', () => {
        it('prefers an explicit name', () => {
            expect(dashboardSessionTitle(makeSummary({ metadata: { path: '/x', name: 'auth-rate-limit' } }))).toBe('auth-rate-limit')
        })

        it('falls back to the working-directory basename so the row is still recognisable', () => {
            expect(dashboardSessionTitle(makeSummary({ metadata: { path: '/home/tomas/git/blog-redesign' } }))).toBe('blog-redesign')
        })

        it('falls back to a short id when there is neither name nor path', () => {
            expect(dashboardSessionTitle(makeSummary({ metadata: null }))).toBe('sess-abc')
        })
    })
})

describe('DASHBOARD_STATUS_META', () => {
    context('status must survive a colour-blind glance, so every state carries an icon and a word', () => {
        it('has a non-empty icon and short label for every status', () => {
            for (const meta of Object.values(DASHBOARD_STATUS_META)) {
                expect(meta.icon.length).toBeGreaterThan(0)
                expect(meta.short.length).toBeGreaterThan(0)
            }
        })
    })
})
