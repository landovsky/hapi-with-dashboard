import { useCallback, useEffect, useRef, useState } from 'react'

export type RecorderState = 'idle' | 'recording' | 'unsupported' | 'denied'

export interface AudioRecorder {
    state: RecorderState
    /** Begin capturing from the mic. No-op (sets `denied`) if permission fails. */
    start: () => Promise<void>
    /** Stop and resolve the captured clip (null if nothing was recorded). */
    stop: () => Promise<Blob | null>
    error: string | null
}

// Preference order — Chrome/FF speak webm/opus; Safari only does mp4. We let the
// browser pick the first it supports and send whatever it produced to /stt,
// which keys off the blob's Content-Type.
const PREFERRED_MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']

function pickMimeType(): string | undefined {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
        return undefined
    }
    return PREFERRED_MIME.find((m) => MediaRecorder.isTypeSupported(m))
}

/**
 * Thin wrapper over MediaRecorder for the voice view's tap-to-talk: tap to
 * start, tap to stop-and-get-the-clip. Tracks live state so the mic dock can
 * render listening vs idle, and tears the mic stream down on stop/unmount so
 * the OS recording indicator doesn't linger.
 */
export function useAudioRecorder(): AudioRecorder {
    const [state, setState] = useState<RecorderState>(() =>
        typeof window !== 'undefined' && 'MediaRecorder' in window ? 'idle' : 'unsupported'
    )
    const [error, setError] = useState<string | null>(null)
    const recorderRef = useRef<MediaRecorder | null>(null)
    const chunksRef = useRef<Blob[]>([])
    const streamRef = useRef<MediaStream | null>(null)

    const teardownStream = useCallback(() => {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
    }, [])

    useEffect(() => () => teardownStream(), [teardownStream])

    const start = useCallback(async () => {
        setError(null)
        if (typeof window === 'undefined' || !('MediaRecorder' in window)) {
            setState('unsupported')
            return
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            streamRef.current = stream
            const mimeType = pickMimeType()
            const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
            chunksRef.current = []
            rec.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    chunksRef.current.push(e.data)
                }
            }
            recorderRef.current = rec
            rec.start()
            setState('recording')
        } catch (err) {
            teardownStream()
            setState('denied')
            setError(err instanceof Error ? err.message : 'Microphone unavailable')
        }
    }, [teardownStream])

    const stop = useCallback(async (): Promise<Blob | null> => {
        const rec = recorderRef.current
        if (!rec) {
            setState('idle')
            return null
        }
        return await new Promise<Blob | null>((resolve) => {
            rec.onstop = () => {
                const blob = chunksRef.current.length
                    ? new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
                    : null
                teardownStream()
                recorderRef.current = null
                chunksRef.current = []
                setState('idle')
                resolve(blob)
            }
            try {
                rec.stop()
            } catch {
                teardownStream()
                setState('idle')
                resolve(null)
            }
        })
    }, [teardownStream])

    return { state, start, stop, error }
}
