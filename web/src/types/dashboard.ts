/**
 * Wire types for the additive ext endpoints that back the voice dashboard
 * (pins + read-state). These live in a separate `hapi-ext.db` on the hub so the
 * dashboard never touches upstream's high-churn session schema.
 */
import type { SessionSummary } from '@/types/api'

/** A pinned session, in the operator's manual top-to-bottom order. */
export interface DashboardPin {
    sessionId: string
    position: number
    createdAt: number
}

export interface PinsResponse {
    pins: DashboardPin[]
}

/**
 * Map of sessionId → last-seen marker. We use the session's `updatedAt` as the
 * monotonic marker, so a row is "unread" when its live `updatedAt` exceeds the
 * stored value. Server-side (not localStorage) so read-state follows the
 * operator across phone and desktop.
 */
export interface ReadStateResponse {
    readState: Record<string, number>
}

/**
 * Filtered session list for the dashboard. `sessions` are the ones within the
 * window (or all of them when `all` was requested); `total` is the full count
 * regardless of the filter, so the UI can show "showing N of M".
 */
export interface DashboardSessionsResponse {
    sessions: SessionSummary[]
    total: number
    shown: number
    days: number
}

// --- Voice view (tts / stt / summarize / suggest-replies) ------------------

/** One turn of the visible exchange, the shape the summarize/suggest endpoints
 *  expect. The latest assistant turn must be last when asking for replies. */
export interface VoiceTranscriptMessage {
    role: 'user' | 'assistant'
    text: string
}

export interface SttResponse {
    text: string
    language?: string
}

export interface SummarizeResponse {
    summary: string
}

export interface SuggestRepliesResponse {
    replies: string[]
}
