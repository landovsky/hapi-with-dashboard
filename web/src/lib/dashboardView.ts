import type { SessionSummary } from '@/types/api'

/**
 * The "project" a session belongs to — its git worktree root if it has one,
 * else its working directory, else the bucket `'Other'`. This mirrors how the
 * rest of HAPI counts projects (worktree.basePath ?? path), so the dashboard's
 * grouping agrees with the session tree.
 *
 * Sessions with no path at all (rare — e.g. a bare REPL) fall into `'Other'`.
 * If those ever matter, the natural secondary grouping is by machine
 * (`metadata.machineId`); we keep it simple here and bucket them together.
 */
export function projectKey(summary: SessionSummary): string {
    return summary.metadata?.worktree?.basePath ?? summary.metadata?.path ?? 'Other'
}

/** Short, human label for a project key — the last path segment (repo/dir name). */
export function projectLabel(key: string): string {
    if (key === 'Other') {
        return 'Other'
    }
    const trimmed = key.replace(/\/+$/, '')
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
    return base || trimmed || 'Other'
}

/**
 * Local, no-network fulltext match over whatever the row already shows. Every
 * whitespace-separated term must appear somewhere in the haystack (AND search),
 * so "blog css" narrows to rows mentioning both. Empty query matches everything.
 */
export function matchesQuery(fields: Array<string | null | undefined>, query: string): boolean {
    const q = query.trim().toLowerCase()
    if (!q) {
        return true
    }
    const hay = fields.filter(Boolean).join(' ').toLowerCase()
    return q.split(/\s+/).every((term) => hay.includes(term))
}

export interface ProjectGroup<T> {
    key: string
    label: string
    rows: T[]
}

/**
 * Bucket rows by project, biggest groups first, with `'Other'` always last.
 * Group membership preserves the incoming row order (caller sorts upstream).
 */
export function groupRowsByProject<T>(rows: T[], keyOf: (row: T) => string): ProjectGroup<T>[] {
    const map = new Map<string, T[]>()
    for (const row of rows) {
        const key = keyOf(row)
        const bucket = map.get(key)
        if (bucket) {
            bucket.push(row)
        } else {
            map.set(key, [row])
        }
    }
    return Array.from(map.entries())
        .map(([key, groupRows]) => ({ key, label: projectLabel(key), rows: groupRows }))
        .sort((a, b) => {
            if (a.key === 'Other') return 1
            if (b.key === 'Other') return -1
            if (b.rows.length !== a.rows.length) {
                return b.rows.length - a.rows.length
            }
            return a.label.localeCompare(b.label)
        })
}
