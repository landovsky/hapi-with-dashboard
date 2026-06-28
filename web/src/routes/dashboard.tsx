import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useDashboardSessions } from '@/hooks/queries/useDashboardSessions'
import { useGitStatusFiles } from '@/hooks/queries/useGitStatusFiles'
import {
    DASHBOARD_STATUS_META,
    type DashboardStatus,
    dashboardSessionSnippet,
    dashboardSessionTitle,
    deriveDashboardStatus,
    formatElapsed
} from '@/lib/dashboardStatus'
import { groupRowsByProject, matchesQuery, projectKey } from '@/lib/dashboardView'
import type { ApiClient } from '@/api/client'
import type { GitStatusFiles, SessionSummary } from '@/types/api'
import { LoadingState } from '@/components/LoadingState'
import './dashboard.css'

/** A session paired with everything the board needs to render one row, so the
 *  derivation happens once per render and rows stay dumb. */
interface DashboardRow {
    summary: SessionSummary
    status: DashboardStatus
    title: string
    snippet: string
    /** Project key (worktree root / cwd / 'Other') — for grouping + search. */
    project: string
    elapsed: { text: string; warnLong: boolean }
    unread: boolean
    pinned: boolean
}

/** A one-tap instruction the operator can fire at a session straight from its
 *  row. In HAPI the agent does the git work, so "commit" is just a canned
 *  message — no special write endpoint, the session executes it. */
interface QuickAction {
    label: string
    message: string
}

/** Inline quick-actions per status. Only `done` rows get them today: a finished
 *  session is the one you want to resolve (commit / PR) without ever opening it. */
const QUICK_ACTIONS: Partial<Record<DashboardStatus, QuickAction[]>> = {
    done: [
        { label: 'commit', message: 'Commit the current changes with a clear message and push.' },
        { label: 'PR', message: 'Open a pull request for the current changes.' }
    ]
}

function useNow(intervalMs = 30_000): number {
    // A coarse ticking clock so the elapsed counters advance without hammering
    // re-renders. 30s is plenty for "4h12m"-grade copy.
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(id)
    }, [intervalMs])
    return now
}

/** Roll the per-file git numstat up into the one-line diff badge. Returns null
 *  when there's nothing changed, so a clean session shows no stat at all. */
function summarizeDiff(status: GitStatusFiles | null): { added: number; removed: number; files: number; branch: string | null } | null {
    if (!status) {
        return null
    }
    const all = [...status.stagedFiles, ...status.unstagedFiles]
    if (all.length === 0) {
        return null
    }
    const added = all.reduce((sum, f) => sum + (f.linesAdded || 0), 0)
    const removed = all.reduce((sum, f) => sum + (f.linesRemoved || 0), 0)
    const files = new Set(all.map((f) => f.filePath)).size
    return { added, removed, files, branch: status.branch }
}

/**
 * The expanded body of a tile — only mounted when a row is open, so a git
 * status/numstat is fetched for that one session rather than for the whole
 * board. Shows the full last message, a real diff stat, and the two actions
 * that resolve a finished/review session without leaving the dashboard.
 */
function ExpandedTileBody({
    api,
    row,
    onOpen,
    onVoice
}: {
    api: ApiClient | null
    row: DashboardRow
    onOpen: () => void
    onVoice: () => void
}) {
    const { status, isLoading } = useGitStatusFiles(api, row.summary.id)
    const diff = summarizeDiff(status)
    const stop = (e: React.MouseEvent, fn: () => void) => {
        e.stopPropagation()
        fn()
    }
    return (
        <div className="vd-expbody">
            {row.snippet ? (
                <div className="vd-fullwrap">
                    <div className="vd-full">{row.snippet}</div>
                </div>
            ) : null}
            {diff ? (
                <div className="vd-difst">
                    <span className="vd-add">+{diff.added}</span>
                    <span className="vd-del">−{diff.removed}</span>
                    <span className="vd-files">
                        {diff.files} file{diff.files === 1 ? '' : 's'}{diff.branch ? ` · ${diff.branch}` : ''}
                    </span>
                </div>
            ) : isLoading ? (
                <div className="vd-difst-loading">checking diff…</div>
            ) : null}
            <div className="vd-qa">
                <button type="button" className="vd-qbtn vd-alt" onClick={(e) => stop(e, onOpen)}>▤ Read full</button>
                <button type="button" className="vd-qbtn" onClick={(e) => stop(e, onVoice)}>🎙 Reply by voice</button>
            </div>
        </div>
    )
}

function StatusChip({ status }: { status: DashboardStatus }) {
    const meta = DASHBOARD_STATUS_META[status]
    return (
        <span className="vd-lead" style={{ background: meta.soft, color: meta.chipText }}>
            <span aria-hidden>{meta.icon}</span>
            {meta.short}
        </span>
    )
}

interface DashboardTileProps {
    api: ApiClient | null
    row: DashboardRow
    expanded: boolean
    canMoveUp: boolean
    canMoveDown: boolean
    quickActions: QuickAction[]
    sentNote: { text: string; failed: boolean } | null
    onToggle: () => void
    onOpen: () => void
    onVoice: () => void
    onTogglePin: () => void
    onMoveUp: () => void
    onMoveDown: () => void
    onQuickAction: (action: QuickAction) => void
}

function DashboardTile({
    api,
    row,
    expanded,
    canMoveUp,
    canMoveDown,
    quickActions,
    sentNote,
    onToggle,
    onOpen,
    onVoice,
    onTogglePin,
    onMoveUp,
    onMoveDown,
    onQuickAction
}: DashboardTileProps) {
    const meta = DASHBOARD_STATUS_META[row.status]
    const stop = (e: React.MouseEvent, fn: () => void) => {
        e.stopPropagation()
        fn()
    }
    return (
        <div
            className={`vd-tile${expanded ? ' vd-exp' : ''}${row.status === 'dead' ? ' vd-dead' : ''}`}
            style={{ borderLeftColor: meta.accent }}
            onClick={onToggle}
            onKeyDown={(e) => {
                // Toggle on Enter/Space only when the tile itself holds focus —
                // never when the key bubbled up from an inner action button.
                if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                    e.preventDefault()
                    onToggle()
                }
            }}
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
        >
            <div className="vd-thead">
                {row.pinned ? <span className="vd-pin" aria-label="pinned">📌</span> : null}
                <StatusChip status={row.status} />
                <span className="vd-ttl">{row.title}</span>
                {row.unread ? <span className="vd-unread" aria-label="unread" /> : null}
                <span className={`vd-el${row.elapsed.warnLong ? ' vd-warnlong' : ''}`}>⧗{row.elapsed.text}</span>
            </div>
            {row.snippet ? <div className="vd-snip">{row.snippet}</div> : null}
            <div className="vd-rowacts">
                <button
                    type="button"
                    className={`vd-ico${row.pinned ? ' vd-on' : ''}`}
                    title={row.pinned ? 'Unpin' : 'Pin to top'}
                    aria-pressed={row.pinned}
                    onClick={(e) => stop(e, onTogglePin)}
                >
                    <span style={{ opacity: row.pinned ? 1 : 0.4 }}>📌</span>
                </button>
                {row.pinned ? (
                    <>
                        <button
                            type="button"
                            className="vd-ico"
                            title="Move up"
                            disabled={!canMoveUp}
                            onClick={(e) => stop(e, onMoveUp)}
                        >↑</button>
                        <button
                            type="button"
                            className="vd-ico"
                            title="Move down"
                            disabled={!canMoveDown}
                            onClick={(e) => stop(e, onMoveDown)}
                        >↓</button>
                    </>
                ) : null}
                <button type="button" className="vd-ico vd-mic vd-spacer" title="Talk to this session" onClick={(e) => stop(e, onVoice)}>🎙</button>
                <button type="button" className="vd-ico" title={expanded ? 'Collapse' : 'Expand'} onClick={(e) => stop(e, onToggle)}>⤢</button>
                <button type="button" className="vd-ico" title="Open in HAPI" onClick={(e) => stop(e, onOpen)}>↗</button>
            </div>
            {quickActions.length > 0 ? (
                <div className="vd-qmini">
                    {sentNote ? (
                        <span className={`vd-sent${sentNote.failed ? ' vd-sent-fail' : ''}`}>{sentNote.text}</span>
                    ) : (
                        quickActions.map((a) => (
                            <button key={a.label} type="button" className="vd-q" onClick={(e) => stop(e, () => onQuickAction(a))}>
                                {a.label}
                            </button>
                        ))
                    )}
                </div>
            ) : null}
            {expanded ? (
                <ExpandedTileBody api={api} row={row} onOpen={onOpen} onVoice={onVoice} />
            ) : null}
        </div>
    )
}

export default function DashboardPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const now = useNow()
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [sentNotes, setSentNotes] = useState<Record<string, { text: string; failed: boolean }>>({})
    // Toolbar state: show-all overrides the backend 5-day window; search filters
    // locally; group toggles the project layout.
    const [showAll, setShowAll] = useState(false)
    const [search, setSearch] = useState('')
    const [grouped, setGrouped] = useState(false)

    // Sessions come pre-filtered to the last few days from the backend (or all,
    // when the checkbox is on). The hook polls so the board stays live.
    const { sessions, total, days, isLoading, error } = useDashboardSessions(api, showAll)

    const pinsQuery = useQuery({
        queryKey: ['dashboard', 'pins'],
        queryFn: () => api!.listPins(),
        enabled: Boolean(api),
        refetchInterval: 15_000
    })
    const readStateQuery = useQuery({
        queryKey: ['dashboard', 'read-state'],
        queryFn: () => api!.getReadState(),
        enabled: Boolean(api),
        refetchInterval: 15_000
    })

    const pinOrder = useMemo(() => {
        const pins = pinsQuery.data?.pins ?? []
        return new Map(pins.map((p) => [p.sessionId, p.position]))
    }, [pinsQuery.data])
    const readState = readStateQuery.data?.readState ?? {}

    const allRows = useMemo<DashboardRow[]>(() => sessions.map((summary) => {
        const lastSeenAt = readState[summary.id] ?? 0
        const status = deriveDashboardStatus(summary, { lastSeenAt, now })
        return {
            summary,
            status,
            title: dashboardSessionTitle(summary),
            snippet: dashboardSessionSnippet(summary),
            project: projectKey(summary),
            elapsed: formatElapsed(summary, status, now),
            unread: summary.updatedAt > lastSeenAt && lastSeenAt > 0,
            pinned: pinOrder.has(summary.id)
        }
    }), [sessions, readState, pinOrder, now])

    // Local fulltext over what the row already shows — no server round-trip.
    const filteredRows = useMemo(() => {
        if (!search.trim()) {
            return allRows
        }
        return allRows.filter((r) => matchesQuery(
            [r.title, r.snippet, r.project, DASHBOARD_STATUS_META[r.status].short, r.summary.metadata?.path, r.summary.model],
            search
        ))
    }, [allRows, search])

    const pinnedRows = useMemo(
        () => filteredRows
            .filter((r) => r.pinned)
            .sort((a, b) => (pinOrder.get(a.summary.id) ?? 0) - (pinOrder.get(b.summary.id) ?? 0)),
        [filteredRows, pinOrder]
    )
    // "Everything else" most-recent-first; pinned rows are the manually ordered
    // set, the rest follows recency so fresh activity floats up.
    const otherRows = useMemo(
        () => filteredRows
            .filter((r) => !r.pinned)
            .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt),
        [filteredRows]
    )
    const waitingRow = useMemo(
        () => otherRows.find((r) => r.status === 'waiting') ?? pinnedRows.find((r) => r.status === 'waiting') ?? null,
        [otherRows, pinnedRows]
    )
    // When grouping is on, the non-pinned rows are bucketed by project; pinned
    // stays its own manual section on top.
    const projectGroups = useMemo(
        () => grouped ? groupRowsByProject(otherRows, (r) => r.project) : [],
        [grouped, otherRows]
    )

    const activeCount = useMemo(() => sessions.filter((s) => s.active).length, [sessions])
    const visibleCount = filteredRows.length

    const openSession = useCallback((sessionId: string) => {
        navigate({ to: '/sessions/$sessionId', params: { sessionId } })
    }, [navigate])

    const talkToSession = useCallback((sessionId: string) => {
        navigate({ to: '/voice/$sessionId', params: { sessionId } })
    }, [navigate])

    const toggleExpand = useCallback((row: DashboardRow) => {
        setExpandedId((prev) => (prev === row.summary.id ? null : row.summary.id))
        // Opening a row counts as seeing it — clear the unread marker server-side.
        if (row.unread && api) {
            void api.markSeen(row.summary.id, row.summary.updatedAt).then(() => {
                void queryClient.invalidateQueries({ queryKey: ['dashboard', 'read-state'] })
            }).catch(() => { /* read-state is best-effort */ })
        }
    }, [api, queryClient])

    const invalidatePins = useCallback(
        () => queryClient.invalidateQueries({ queryKey: ['dashboard', 'pins'] }),
        [queryClient]
    )

    const togglePin = useCallback((row: DashboardRow) => {
        if (!api) {
            return
        }
        const op = row.pinned ? api.removePin(row.summary.id) : api.addPin(row.summary.id)
        void op.then(invalidatePins).catch(() => { /* pin is best-effort */ })
    }, [api, invalidatePins])

    // Manual reorder via up/down — touch-friendly and library-free. We send the
    // whole desired order so the hub never has to infer intent; the pinned set
    // stays exactly where the operator put it (never auto-sorted).
    const movePinned = useCallback((sessionId: string, direction: -1 | 1) => {
        if (!api) {
            return
        }
        const order = pinnedRows.map((r) => r.summary.id)
        const from = order.indexOf(sessionId)
        const to = from + direction
        if (from === -1 || to < 0 || to >= order.length) {
            return
        }
        ;[order[from], order[to]] = [order[to], order[from]]
        void api.reorderPins(order).then(invalidatePins).catch(() => { /* best-effort */ })
    }, [api, pinnedRows, invalidatePins])

    // Briefly confirm a fired quick-action on the row itself, then fade it.
    const flashSent = useCallback((sessionId: string, text: string, failed: boolean) => {
        setSentNotes((prev) => ({ ...prev, [sessionId]: { text, failed } }))
        setTimeout(() => {
            setSentNotes((prev) => {
                if (!(sessionId in prev)) {
                    return prev
                }
                const next = { ...prev }
                delete next[sessionId]
                return next
            })
        }, 2600)
    }, [])

    const runQuickAction = useCallback((sessionId: string, action: QuickAction) => {
        if (!api) {
            return
        }
        // Optimistic — the instruction is fire-and-forget; the agent does the work.
        flashSent(sessionId, `✓ ${action.label} sent`, false)
        void api.sendMessage(sessionId, action.message).catch(() => {
            flashSent(sessionId, `⚠ ${action.label} failed`, true)
        })
    }, [api, flashSent])

    const renderRow = (row: DashboardRow, index: number, list: DashboardRow[]) => (
        <DashboardTile
            key={row.summary.id}
            api={api}
            row={row}
            expanded={expandedId === row.summary.id}
            canMoveUp={row.pinned && index > 0}
            canMoveDown={row.pinned && index < list.length - 1}
            quickActions={QUICK_ACTIONS[row.status] ?? []}
            sentNote={sentNotes[row.summary.id] ?? null}
            onToggle={() => toggleExpand(row)}
            onOpen={() => openSession(row.summary.id)}
            onVoice={() => talkToSession(row.summary.id)}
            onTogglePin={() => togglePin(row)}
            onMoveUp={() => movePinned(row.summary.id, -1)}
            onMoveDown={() => movePinned(row.summary.id, 1)}
            onQuickAction={(a) => runQuickAction(row.summary.id, a)}
        />
    )

    return (
        <div className="vd-root">
            <div className="vd-scroll">
                <div className="vd-topbar">
                    <h2>
                        sessions<span className="vd-dim">/{total}</span>
                    </h2>
                    <span className="vd-live">
                        <span className="vd-d" />
                        {activeCount} active
                    </span>
                </div>

                <div className="vd-toolbar">
                    <input
                        className="vd-search"
                        type="search"
                        inputMode="search"
                        placeholder="Search sessions…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Search sessions"
                    />
                    <div className="vd-toolbar-row">
                        <label className="vd-check">
                            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                            Show all
                        </label>
                        <label className="vd-check">
                            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
                            Group by project
                        </label>
                        <span className="vd-count">
                            {visibleCount} of {total}{showAll ? '' : ` · last ${days}d`}
                        </span>
                    </div>
                </div>

                {error ? <div className="vd-empty">{error}</div> : null}

                {waitingRow ? (
                    <button
                        type="button"
                        className="vd-pill"
                        onClick={() => talkToSession(waitingRow.summary.id)}
                    >
                        <span className="vd-pulse" />
                        WAITING · {waitingRow.title}
                        <span className="vd-arrow">jump ↑</span>
                    </button>
                ) : null}

                {isLoading && sessions.length === 0 ? (
                    <LoadingState label="Loading sessions…" className="text-sm" />
                ) : null}

                {pinnedRows.length > 0 ? (
                    <>
                        <div className="vd-sec">Pinned</div>
                        {pinnedRows.map(renderRow)}
                    </>
                ) : null}

                {grouped ? (
                    projectGroups.map((group) => (
                        <div key={group.key}>
                            <div className="vd-sec">
                                {group.label}<span className="vd-sec-n">·{group.rows.length}</span>
                            </div>
                            {group.rows.map(renderRow)}
                        </div>
                    ))
                ) : otherRows.length > 0 ? (
                    <>
                        {pinnedRows.length > 0 ? <div className="vd-sec">Everything else</div> : null}
                        {otherRows.map(renderRow)}
                    </>
                ) : null}

                {!isLoading && visibleCount === 0 && !error ? (
                    <div className="vd-empty">
                        {search.trim()
                            ? `No sessions match “${search.trim()}”.`
                            : showAll
                                ? 'No sessions.'
                                : `Nothing in the last ${days} days — tick “Show all”.`}
                    </div>
                ) : null}
            </div>
        </div>
    )
}
