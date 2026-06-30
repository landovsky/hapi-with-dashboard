import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import {
    extractLastAssistantSpeakable,
    extractLastAssistantSpeakableDetailed,
    formatMessage,
    formatNewMessages,
    formatReadyEvent,
    VOICE_PREAMBLE
} from './contextFormatters'

const context = describe

function msg(partial: Pick<DecryptedMessage, 'id' | 'seq' | 'content'>): DecryptedMessage {
    return {
        id: partial.id,
        seq: partial.seq,
        localId: null,
        content: partial.content,
        createdAt: 0,
        sessionId: 'session-1'
    } as DecryptedMessage
}

describe('extractLastAssistantSpeakable', () => {
    it('returns null for empty history', () => {
        expect(extractLastAssistantSpeakable([])).toBeNull()
    })

    it('returns the latest assistant plain string', () => {
        const messages = [
            msg({ id: '1', seq: 1, content: { role: 'user', content: 'hello' } }),
            msg({ id: '2', seq: 2, content: { role: 'assistant', content: 'first reply' } }),
            msg({ id: '3', seq: 3, content: { role: 'assistant', content: '  latest reply  ' } })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('latest reply')
    })

    it('skips trailing user messages and reads earlier assistant text', () => {
        const messages = [
            msg({ id: '1', seq: 1, content: { role: 'assistant', content: 'done with the refactor' } }),
            msg({ id: '2', seq: 2, content: { role: 'user', content: 'thanks' } })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('done with the refactor')
    })

    it('extracts text blocks from assistant content arrays', () => {
        const messages = [
            msg({
                id: '1',
                seq: 1,
                content: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Part one.' },
                        { type: 'text', text: 'Part two.' }
                    ]
                }
            })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('Part one.\n\nPart two.')
    })

    it('extracts codex stream-json assistant messages', () => {
        const messages = [
            msg({
                id: '1',
                seq: 1,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: 'Indexed 5,018 items in the search database.'
                        }
                    }
                }
            }),
            msg({
                id: '2',
                seq: 2,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: { type: 'ready' }
                    }
                }
            })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('Indexed 5,018 items in the search database.')
    })

    it('unwraps codex-style output envelopes', () => {
        const messages = [
            msg({
                id: '1',
                seq: 1,
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: { content: 'Codex finished the refactor.' }
                    }
                }
            })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('Codex finished the refactor.')
    })
})

describe('extractLastAssistantSpeakableDetailed', () => {
    context('the voice view must only read aloud replies it was actually asked to speak — auto-reading old chat answers burned ElevenLabs credits on entry', () => {
        it('flags a reply as voice-originated when the prompting user turn carried the voice preamble', () => {
            const messages = [
                msg({ id: '1', seq: 1, content: { role: 'user', content: `${VOICE_PREAMBLE}\n\nwhat's the status?` } }),
                msg({ id: '2', seq: 2, content: { role: 'assistant', content: 'All green.' } })
            ]
            expect(extractLastAssistantSpeakableDetailed(messages)).toEqual({
                text: 'All green.',
                seq: 2,
                voiceOriginated: true
            })
        })

        it('leaves an ordinary chat reply un-flagged so it is shown but never auto-spoken', () => {
            const messages = [
                msg({ id: '1', seq: 1, content: { role: 'user', content: 'walk me through the whole migration plan' } }),
                msg({ id: '2', seq: 2, content: { role: 'assistant', content: 'a very long answer…' } })
            ]
            expect(extractLastAssistantSpeakableDetailed(messages)).toEqual({
                text: 'a very long answer…',
                seq: 2,
                voiceOriginated: false
            })
        })

        it('carries the reply seq so the view can track played-state by identity rather than by fragile text equality', () => {
            const messages = [
                msg({ id: '1', seq: 7, content: { role: 'user', content: `${VOICE_PREAMBLE}\n\nhi` } }),
                msg({ id: '2', seq: 8, content: { role: 'assistant', content: 'Hi back.' } })
            ]
            expect(extractLastAssistantSpeakableDetailed(messages)?.seq).toBe(8)
        })

        it('looks past an intervening tool call to find the prompting voice user turn', () => {
            const messages = [
                msg({ id: '1', seq: 1, content: { role: 'user', content: `${VOICE_PREAMBLE}\n\nrun the build` } }),
                msg({ id: '2', seq: 2, content: { role: 'assistant', content: [{ type: 'tool_use', name: 'bash', input: {} }] } }),
                msg({ id: '3', seq: 3, content: { role: 'assistant', content: 'Build passed.' } })
            ]
            expect(extractLastAssistantSpeakableDetailed(messages)?.voiceOriginated).toBe(true)
        })

        it('returns null for empty history', () => {
            expect(extractLastAssistantSpeakableDetailed([])).toBeNull()
        })
    })
})

describe('formatReadyEvent', () => {
    const sessionId = '9d04335d-2b90-4941-98a7-eb414823f0e0'

    it('embeds assistant text when provided', () => {
        const text = 'Added full-text search to the API module.'
        const event = formatReadyEvent(sessionId, text)
        expect(event).toContain('coding agent finished working')
        expect(event).toContain(`<text>${text}</text>`)
        expect(event).not.toContain('Claude Code')
    })

    it('falls back when assistant text is missing', () => {
        const event = formatReadyEvent(sessionId, null)
        expect(event).toContain('Use the latest agent message already present in context')
        expect(event).not.toContain('Claude Code')
    })

    it('treats blank assistant text as missing', () => {
        const event = formatReadyEvent(sessionId, '   ')
        expect(event).toContain('Use the latest agent message already present in context')
    })
})

describe('formatMessage', () => {
    it('uses the supplied agent label as the assistant prefix', () => {
        const formatted = formatMessage(msg({
            id: '1',
            seq: 1,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        message: 'Indexed 5,018 items in the search database.'
                    }
                }
            }
        }), 'Codex')

        expect(formatted).toContain('Codex:')
        expect(formatted).not.toContain('Claude Code')
        expect(formatted).toContain('<text>Indexed 5,018 items in the search database.</text>')
    })

    it('threads agentLabel for a different flavor (regression for #680)', () => {
        const formatted = formatMessage(msg({
            id: '1',
            seq: 1,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        message: 'Cursor is generating a plan.'
                    }
                }
            }
        }), 'Cursor')

        expect(formatted).toContain('Cursor:')
        expect(formatted).not.toContain('Claude Code')
    })

    it('ignores codex ready and tool-call payloads', () => {
        expect(formatMessage(msg({
            id: '1',
            seq: 1,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: { type: 'ready' }
                }
            }
        }), 'Codex')).toBeNull()
    })

    it('does not treat session status events as speakable assistant text', () => {
        expect(formatMessage(msg({
            id: '1',
            seq: 1,
            content: {
                role: 'agent',
                content: {
                    id: 'some-uuid',
                    type: 'event',
                    data: { type: 'message', message: 'Aborting task.' }
                }
            }
        }), 'Codex')).toBeNull()
    })

    it('preserves tool-call context for mixed text+tool_use content array and uses the agent label', () => {
        const formatted = formatMessage(msg({
            id: '1',
            seq: 1,
            content: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Here is the result.' },
                    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
                ]
            }
        }), 'Claude')

        expect(formatted).toContain('Here is the result.')
        expect(formatted).toContain('Claude is using Bash')
        expect(formatted).not.toContain('Claude Code is using')
    })
})

describe('formatNewMessages', () => {
    it('includes codex assistant replies in contextual updates', () => {
        const update = formatNewMessages('session-1', [
            msg({
                id: '1',
                seq: 1,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: 'Local database file size is 2.43 GiB.'
                        }
                    }
                }
            })
        ], 'Codex')

        expect(update).toContain('New messages in session: session-1')
        expect(update).toContain('Local database file size is 2.43 GiB.')
        expect(update).toContain('Codex:')
        expect(update).not.toContain('Claude Code')
    })
})
