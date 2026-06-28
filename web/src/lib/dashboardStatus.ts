import type { SessionSummary } from '@/types/api'

/**
 * The six triage states the voice dashboard speaks in (Direction B —
 * "dense / triage", a terminal flight-board). Status is always carried by
 * colour + icon + shape together, never colour alone, so a glance works in
 * sunlight and for colour-blind eyes.
 */
export type DashboardStatus =
    | 'waiting' // blocked on a decision from you (a permission / input request is open)
    | 'working' // the agent is actively running; we show elapsed so a long-runner can't hide
    | 'review' // produced new output you haven't looked at yet
    | 'done' // finished its task list (or exited cleanly) — actionable, resolve without opening
    | 'idle' // alive but quiet; nothing new since you last looked
    | 'dead' // the process exited abnormally

export interface DashboardStatusContext {
    /**
     * The `updatedAt` value this session had the last time the operator looked
     * at it (from the ext read-state store). A session is "unread" when its
     * live `updatedAt` has moved past this — that is what lets the grid hold a
     * STABLE manual order while still signalling that a row advanced.
     */
    lastSeenAt: number
    /** Epoch ms "now", injected so the derivation is deterministic under test. */
    now: number
}

/** A todo list that exists and is fully checked off — our best signal from a
 *  bare SessionSummary that the agent actually *finished the thing it set out
 *  to do*, as opposed to merely going quiet. */
function hasCompletedAllTodos(summary: SessionSummary): boolean {
    const p = summary.todoProgress
    return Boolean(p && p.total > 0 && p.completed >= p.total)
}

/** Lifecycle strings the runner uses when a session ended badly. Matched
 *  loosely because the exact vocabulary drifts across agent flavors. */
const ABNORMAL_EXIT = /exit|error|crash|fail|dead|kill|abort/i

/**
 * Collapse a live SessionSummary into one triage state. Order matters: a
 * blocking question outranks "it's still working", which outranks "it
 * finished", which outranks "there's something to read".
 *
 * Note on done-vs-review: a bare SessionSummary cannot tell "tests are green,
 * ready to commit" from "wrote 1,240 words to read" — that needs git/output
 * inspection. We approximate: a fully-checked todo list reads as `done`
 * (actionable), any other fresh output reads as `review` (needs your eyes).
 * Centralising it here keeps that approximation in one place to refine later.
 */
export function deriveDashboardStatus(
    summary: SessionSummary,
    ctx: DashboardStatusContext
): DashboardStatus {
    const pending = summary.pendingRequestsCount > 0 || summary.pendingRequestKinds.length > 0
    if (pending) {
        return 'waiting'
    }

    if (summary.thinking) {
        return 'working'
    }

    const lifecycle = summary.metadata?.lifecycleState ?? ''
    if (!summary.active) {
        if (ABNORMAL_EXIT.test(lifecycle)) {
            return 'dead'
        }
        // A clean stop that completed its plan is "done"; otherwise it's just
        // parked and waiting for the next instruction.
        return hasCompletedAllTodos(summary) ? 'done' : 'idle'
    }

    // Alive, not thinking, nothing blocking it.
    if (hasCompletedAllTodos(summary)) {
        return 'done'
    }
    if (summary.updatedAt > ctx.lastSeenAt) {
        return 'review'
    }
    return 'idle'
}

export interface DashboardStatusMeta {
    /** Long human label for the voice-view header chip. */
    label: string
    /** Compact flight-board label (the leading chip on each row). */
    short: string
    /** Glyph carried alongside colour so status survives a colour-blind glance. */
    icon: string
    /** Accent colour (the row's left border + chip text on the dark board). */
    accent: string
    /** Soft fill behind the leading chip. */
    soft: string
    /** Readable chip text colour on top of `soft`. */
    chipText: string
}

/** Single source of truth for how each state looks — mirrors the status
 *  language frozen into the mockup's CSS custom properties. */
export const DASHBOARD_STATUS_META: Record<DashboardStatus, DashboardStatusMeta> = {
    waiting: { label: 'Waiting', short: 'WAIT', icon: '⏸', accent: '#F0A92B', soft: '#FBEACB', chipText: '#9a6a10' },
    done: { label: 'Done', short: 'DONE', icon: '✓', accent: '#1FB07A', soft: '#D5F0E4', chipText: '#0f7a53' },
    review: { label: 'Review', short: 'REVIEW', icon: '▤', accent: '#3D7DF2', soft: '#DCE8FE', chipText: '#2862c9' },
    working: { label: 'Working', short: 'WORK', icon: '◴', accent: '#8B6FE8', soft: '#E7E0FB', chipText: '#5a44b8' },
    idle: { label: 'Idle', short: 'IDLE', icon: '○', accent: '#9A958B', soft: '#ECE8DF', chipText: '#7c7565' },
    dead: { label: 'Dead', short: 'DEAD', icon: '✕', accent: '#B5564E', soft: '#efd9d6', chipText: '#9a3f38' }
}

/** Statuses that mean "this row wants you" — used to surface the off-screen
 *  waiting pill and to order which session the pill jumps to first. */
export const ATTENTION_STATUSES: ReadonlySet<DashboardStatus> = new Set(['waiting'])

export interface ElapsedDisplay {
    /** Compact clock, e.g. "4h12m", "3m", "45s", "2d". */
    text: string
    /** True when a *working* session has run long enough to flag amber so it
     *  can't quietly hide (the 4h+ runner problem). */
    warnLong: boolean
}

const LONG_RUN_MS = 60 * 60 * 1000 // 1h — past this a working session is flagged

/**
 * The elapsed clock shown on every row. For a working session we count from
 * `activeAt` (how long it's been grinding); for everything else from
 * `updatedAt` (how stale it is). Both answer "should this be bothering me?".
 */
export function formatElapsed(
    summary: SessionSummary,
    status: DashboardStatus,
    now: number
): ElapsedDisplay {
    const since = status === 'working' ? summary.activeAt : summary.updatedAt
    const ms = Math.max(0, now - since)
    const warnLong = status === 'working' && ms >= LONG_RUN_MS
    return { text: humanizeDuration(ms), warnLong }
}

function humanizeDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000)
    if (totalSec < 60) {
        return `${totalSec}s`
    }
    const totalMin = Math.floor(totalSec / 60)
    if (totalMin < 60) {
        return `${totalMin}m`
    }
    const totalHr = Math.floor(totalMin / 60)
    if (totalHr < 24) {
        const mins = totalMin % 60
        return mins ? `${totalHr}h${mins}m` : `${totalHr}h`
    }
    const days = Math.floor(totalHr / 24)
    const hrs = totalHr % 24
    return hrs ? `${days}d${hrs}h` : `${days}d`
}

/** Best-effort display title for a session row: explicit name, else the last
 *  path segment of its working directory, else a short id. */
export function dashboardSessionTitle(summary: SessionSummary): string {
    const name = summary.metadata?.name?.trim()
    if (name) {
        return name
    }
    const path = summary.metadata?.path?.replace(/\/+$/, '')
    if (path) {
        const base = path.slice(path.lastIndexOf('/') + 1)
        if (base) {
            return base
        }
    }
    return summary.id.slice(0, 8)
}

/** The one-line snippet under the title — the agent's running summary text. */
export function dashboardSessionSnippet(summary: SessionSummary): string {
    return summary.metadata?.summary?.text?.trim() ?? ''
}
