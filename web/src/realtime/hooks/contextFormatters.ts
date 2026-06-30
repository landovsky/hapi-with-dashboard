import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { isObject } from '@hapi/protocol'
import type { DecryptedMessage, Session } from '@/types/api'
import { VOICE_CONFIG } from '../voiceConfig'

interface SessionMetadata {
    summary?: { text?: string }
    path?: string
    machineId?: string
    homeDir?: string
}

interface ContentItem {
    type: string
    text?: string
    name?: string
    input?: unknown
}

type NormalizedRole = 'assistant' | 'user'

function isContentArray(content: unknown): content is ContentItem[] {
    return Array.isArray(content)
}

function normalizeRole(role: string | null | undefined): NormalizedRole | null {
    if (role === 'agent' || role === 'assistant') return 'assistant'
    if (role === 'user') return 'user'
    return null
}

function unwrapRoleWrappedContent(message: DecryptedMessage): { role: NormalizedRole | null; content: unknown } {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return { role: null, content: message.content }
    }
    return { role: normalizeRole(record.role), content: record.content }
}

function unwrapOutputContent(content: unknown): { roleOverride: NormalizedRole | null; content: unknown } {
    if (!isObject(content) || content.type !== 'output') {
        return { roleOverride: null, content }
    }

    const data = isObject(content.data) ? content.data : null
    if (!data || typeof data.type !== 'string') {
        return { roleOverride: null, content }
    }

    const message = isObject(data.message) ? data.message : null
    if (!message) {
        return { roleOverride: null, content }
    }

    const messageContent = (message as { content?: unknown }).content
    if (typeof messageContent === 'undefined') {
        return { roleOverride: null, content }
    }

    const roleOverride = data.type === 'assistant'
        ? 'assistant'
        : data.type === 'user'
            ? 'user'
            : null

    return { roleOverride, content: messageContent }
}

function formatPlainText(role: NormalizedRole | null, text: string, agentLabel: string): string {
    if (role === 'assistant') {
        return `${agentLabel}: \n<text>${text}</text>`
    }
    return `User sent message: \n<text>${text}</text>`
}

/**
 * Format a permission request for natural language context.
 *
 * `agentLabel` is the display label for the session's agent flavor
 * (e.g. "Claude", "Cursor", "Codex"); voiceHooks computes it once per call.
 */
export function formatPermissionRequest(
    sessionId: string,
    requestId: string,
    toolName: string,
    toolArgs: unknown,
    agentLabel: string
): string {
    return `${agentLabel} is requesting permission to use ${toolName} (session ${sessionId}):
<request_id>${requestId}</request_id>
<tool_name>${toolName}</tool_name>
<tool_args>${JSON.stringify(toolArgs)}</tool_args>`
}

/**
 * Format a single message for voice context.
 *
 * `agentLabel` is the display label for the session's agent flavor
 * (e.g. "Claude", "Cursor", "Codex"); voiceHooks computes it once per call.
 */
export function formatMessage(message: DecryptedMessage, agentLabel: string): string | null {
    const { role, content: wrappedContent } = unwrapRoleWrappedContent(message)
    const { roleOverride, content } = unwrapOutputContent(wrappedContent)
    const normalizedRole = roleOverride ?? role

    if (isNonSpeakableAgentPayload(wrappedContent) || isNonSpeakableAgentPayload(content)) {
        return null
    }

    const speakable = !isContentArray(content) ? extractSpeakableFromContent(content) : null
    if (speakable) {
        const roleForFormat = normalizedRole === 'user' ? 'user' : 'assistant'
        return formatPlainText(roleForFormat, speakable, agentLabel)
    }

    if (!isContentArray(content)) {
        return null
    }

    const lines: string[] = []

    // Determine message type by checking for tool_use (assistant) vs user content
    const hasToolUse = content.some(item => item.type === 'tool_use')
    const isAssistant = normalizedRole === 'assistant'
        ? true
        : normalizedRole === 'user'
            ? false
            : hasToolUse || content.some(item => item.type === 'text' && content.length === 1 === false)

    for (const item of content) {
        if (item.type === 'text' && item.text) {
            lines.push(formatPlainText(isAssistant ? 'assistant' : 'user', item.text, agentLabel))
        } else if (item.type === 'tool_use' && !VOICE_CONFIG.DISABLE_TOOL_CALLS) {
            const name = item.name || 'unknown'
            if (VOICE_CONFIG.LIMITED_TOOL_CALLS) {
                lines.push(`${agentLabel} is using ${name}`)
            } else {
                lines.push(`${agentLabel} is using ${name} with arguments: <arguments>${JSON.stringify(item.input)}</arguments>`)
            }
        }
    }

    if (lines.length === 0) {
        return null
    }
    return lines.join('\n\n')
}

function extractSpeakableFromContent(content: unknown): string | null {
    if (typeof content === 'string' && content.trim()) {
        return content.trim()
    }

    if (isObject(content) && content.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
        return content.text.trim()
    }

    // Codex / stream-json agent messages: { type: 'codex', data: { type: 'message', message: '...' } }
    if (isObject(content) && content.type === 'codex' && isObject(content.data)) {
        const data = content.data
        if (data.type === 'message' && typeof data.message === 'string' && data.message.trim()) {
            return data.message.trim()
        }
    }

    if (!isContentArray(content)) {
        return null
    }

    const textParts = content
        .filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text!.trim())
        .filter(Boolean)

    if (textParts.length > 0) {
        return textParts.join('\n\n')
    }

    return null
}

function isNonSpeakableAgentPayload(content: unknown): boolean {
    if (!isObject(content) || typeof content.type !== 'string') {
        return false
    }

    if (content.type === 'codex' && isObject(content.data)) {
        const eventType = content.data.type
        return eventType === 'ready'
            || eventType === 'tool-call'
            || eventType === 'tool-call-result'
            || eventType === 'event'
    }

    return false
}

/** One-line hat the voice view prepends to voice-originated USER messages so
 *  replies come back short and speakable. It's also the only durable signal of
 *  "this assistant reply was generated for voice" — the reply itself carries no
 *  flag, so we detect voice origin by the marker on the user turn that prompted
 *  it. Kept here (not in the route component) so detection and tagging share one
 *  source of truth. */
export const VOICE_PREAMBLE = '[Voice mode — keep your reply short and speakable.]'

/** Normalized role + speakable text for a single message, or null when the
 *  message has nothing readable (tool calls, agent control payloads, etc.). */
function speakableOf(message: DecryptedMessage): { role: NormalizedRole | null; text: string } | null {
    const { role, content: wrappedContent } = unwrapRoleWrappedContent(message)
    const { roleOverride, content } = unwrapOutputContent(wrappedContent)
    if (isNonSpeakableAgentPayload(wrappedContent) || isNonSpeakableAgentPayload(content)) {
        return null
    }
    const text = extractSpeakableFromContent(content)
    if (!text) {
        return null
    }
    return { role: roleOverride ?? role, text }
}

export interface LastAssistantSpeakable {
    text: string
    /** The assistant message's sequence number — the stable identity the voice
     *  view tracks "played" against (text alone is ambiguous and resets on
     *  re-mount). */
    seq: number
    /** True when the user turn that prompted this reply carried VOICE_PREAMBLE,
     *  i.e. the reply was generated for voice and is safe/short to read aloud.
     *  Older chat replies (long, never meant to be spoken) come back false. */
    voiceOriginated: boolean
}

export function extractLastAssistantSpeakable(messages: DecryptedMessage[]): string | null {
    return extractLastAssistantSpeakableDetailed(messages)?.text ?? null
}

/**
 * Like {@link extractLastAssistantSpeakable} but also reports the reply's `seq`
 * and whether it was voice-originated. The voice view uses both to decide
 * whether to auto-read a reply: only voice-originated replies it hasn't already
 * spoken (by seq) should be synthesized, so entering the screen on an old chat
 * session never burns ElevenLabs credits on a long, stale answer.
 */
export function extractLastAssistantSpeakableDetailed(
    messages: DecryptedMessage[]
): LastAssistantSpeakable | null {
    const sorted = [...messages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

    for (let i = sorted.length - 1; i >= 0; i -= 1) {
        const speakable = speakableOf(sorted[i])
        if (!speakable || speakable.role === 'user') {
            continue
        }

        // Walk back to the nearest user turn that prompted this reply and check
        // for the voice marker. A non-user, non-speakable message in between
        // (tool call) doesn't break the link, so we keep scanning past nulls.
        let voiceOriginated = false
        for (let j = i - 1; j >= 0; j -= 1) {
            const prior = speakableOf(sorted[j])
            if (prior?.role === 'user') {
                voiceOriginated = prior.text.includes(VOICE_PREAMBLE)
                break
            }
        }

        return { text: speakable.text, seq: sorted[i].seq ?? 0, voiceOriginated }
    }

    return null
}

export function formatNewSingleMessage(sessionId: string, message: DecryptedMessage, agentLabel: string): string | null {
    const formatted = formatMessage(message, agentLabel)
    if (!formatted) {
        return null
    }
    return 'New message in session: ' + sessionId + '\n\n' + formatted
}

export function formatNewMessages(sessionId: string, messages: DecryptedMessage[], agentLabel: string): string | null {
    const formatted = [...messages]
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .map((m) => formatMessage(m, agentLabel))
        .filter(Boolean)
    if (formatted.length === 0) {
        return null
    }
    return 'New messages in session: ' + sessionId + '\n\n' + formatted.join('\n\n')
}

export function formatHistory(sessionId: string, messages: DecryptedMessage[], agentLabel: string): string {
    const messagesToFormat = VOICE_CONFIG.MAX_HISTORY_MESSAGES > 0
        ? messages.slice(-VOICE_CONFIG.MAX_HISTORY_MESSAGES)
        : messages
    const formatted = messagesToFormat.map((m) => formatMessage(m, agentLabel)).filter(Boolean)
    return 'History of messages in session: ' + sessionId + '\n\n' + formatted.join('\n\n')
}

export function formatSessionFull(session: Session | null, messages: DecryptedMessage[], agentLabel: string): string {
    if (!session) {
        return 'Session not available'
    }

    const sessionName = session.metadata?.summary?.text
    const sessionPath = session.metadata?.path
    const lines: string[] = []

    lines.push(`# Session ID: ${session.id}`)
    lines.push(`# Project path: ${sessionPath}`)
    lines.push(`# Session summary:\n${sessionName}`)

    if (session.metadata?.summary?.text) {
        lines.push('## Session Summary')
        lines.push(session.metadata.summary.text)
        lines.push('')
    }

    lines.push('## Our interaction history so far')
    lines.push('')
    lines.push(formatHistory(session.id, messages, agentLabel))

    return lines.join('\n\n')
}

export function formatSessionOffline(sessionId: string, _metadata?: SessionMetadata): string {
    return `Session went offline: ${sessionId}`
}

export function formatSessionOnline(sessionId: string, _metadata?: SessionMetadata): string {
    return `Session came online: ${sessionId}`
}

export function formatSessionFocus(sessionId: string, _metadata?: SessionMetadata): string {
    return `Session became focused: ${sessionId}`
}

export function formatReadyEvent(sessionId: string, lastAssistantText?: string | null): string {
    const trimmed = lastAssistantText?.trim()
    if (trimmed) {
        return `The coding agent finished working in session: ${sessionId}. Summarize this for the human immediately:\n<text>${trimmed}</text>`
    }
    return `The coding agent finished working in session: ${sessionId}. Use the latest agent message already present in context and summarize it for the human immediately.`
}
