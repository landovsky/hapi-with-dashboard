import { describe, expect, it } from 'bun:test'
import { ExtStore } from './extStore'

const context = describe

function freshStore(): ExtStore {
    // In-memory DB so each test gets an isolated schema with no file on disk.
    return new ExtStore(':memory:')
}

describe('ExtStore tts-state', () => {
    context('voice replies were re-synthesized (and re-billed on ElevenLabs) every time the screen re-mounted, because "played" lived only in client memory', () => {
        it('persists the last-played seq so a later visit can tell the reply was already spoken', () => {
            const store = freshStore()
            store.markTtsPlayed('ns', 'sess-1', 12)
            expect(store.getTtsState('ns')).toEqual({ 'sess-1': 12 })
            store.close()
        })

        it('keeps the high-water mark when an older reply is replayed, so re-reading history never un-marks a newer reply', () => {
            const store = freshStore()
            store.markTtsPlayed('ns', 'sess-1', 20)
            store.markTtsPlayed('ns', 'sess-1', 5)
            expect(store.getTtsState('ns')['sess-1']).toBe(20)
            store.close()
        })

        it('scopes played-state per namespace so one operator\'s playback never suppresses another\'s', () => {
            const store = freshStore()
            store.markTtsPlayed('ns-a', 'sess-1', 3)
            store.markTtsPlayed('ns-b', 'sess-1', 9)
            expect(store.getTtsState('ns-a')).toEqual({ 'sess-1': 3 })
            expect(store.getTtsState('ns-b')).toEqual({ 'sess-1': 9 })
            store.close()
        })

        it('returns an empty map for a namespace that has never read anything aloud', () => {
            const store = freshStore()
            expect(store.getTtsState('ns')).toEqual({})
            store.close()
        })
    })
})
