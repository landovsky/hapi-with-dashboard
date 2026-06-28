import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { groupRowsByProject, matchesQuery, projectKey, projectLabel } from './dashboardView'

const context = describe

function summary(overrides: Partial<SessionSummary['metadata']>): SessionSummary {
    return {
        id: 'x',
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: overrides ? { path: '', ...overrides } : null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null
    } as SessionSummary
}

describe('projectKey', () => {
    context('grouping should agree with the rest of HAPI — repo root if it is a worktree, else the cwd', () => {
        it('prefers the worktree base path (the repo root) over the working dir', () => {
            const s = summary({ path: '/home/t/git/blog/packages/web', worktree: { basePath: '/home/t/git/blog' } as never })
            expect(projectKey(s)).toBe('/home/t/git/blog')
        })

        it('falls back to the working directory when there is no worktree', () => {
            expect(projectKey(summary({ path: '/home/t/git/api' }))).toBe('/home/t/git/api')
        })

        it('buckets a session with no path into Other', () => {
            expect(projectKey(summary(null as never))).toBe('Other')
        })
    })
})

describe('projectLabel', () => {
    it('uses the last path segment as the project name', () => {
        expect(projectLabel('/home/t/git/blog-redesign')).toBe('blog-redesign')
    })
    it('tolerates a trailing slash', () => {
        expect(projectLabel('/home/t/git/api/')).toBe('api')
    })
    it('keeps Other as-is', () => {
        expect(projectLabel('Other')).toBe('Other')
    })
})

describe('matchesQuery', () => {
    context('the operator types into a box and expects only matching rows to remain, no server round-trip', () => {
        it('matches when every term is present somewhere in the row (AND search)', () => {
            expect(matchesQuery(['blog-redesign', 'Refactoring CSS tokens', 'WORK'], 'blog css')).toBe(true)
        })
        it('rejects when any term is missing', () => {
            expect(matchesQuery(['blog-redesign', 'Refactoring CSS tokens'], 'blog python')).toBe(false)
        })
        it('treats an empty query as "show everything"', () => {
            expect(matchesQuery(['anything'], '   ')).toBe(true)
        })
        it('ignores null/undefined fields rather than crashing', () => {
            expect(matchesQuery([null, undefined, 'auth-rate-limit'], 'auth')).toBe(true)
        })
    })
})

describe('groupRowsByProject', () => {
    const rows = [
        { id: 1, key: '/x/blog' },
        { id: 2, key: '/x/blog' },
        { id: 3, key: '/x/api' },
        { id: 4, key: 'Other' }
    ]

    context('a long flat list is easier to scan grouped by repo, biggest projects first', () => {
        it('groups by key, orders by group size, and pins Other last', () => {
            const groups = groupRowsByProject(rows, (r) => r.key)
            expect(groups.map((g) => g.label)).toEqual(['blog', 'api', 'Other'])
            expect(groups[0].rows.map((r) => r.id)).toEqual([1, 2])
        })
    })
})
