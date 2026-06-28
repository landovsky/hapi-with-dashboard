import { useCallback, useEffect, useRef, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

// Check for a new deploy every 15 min (was 60). Combined with the on-focus
// check below, this surfaces the update banner soon after a rollout instead of
// the operator having to reinstall the PWA to get the fresh version.
export const PWA_UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000
export const PWA_UPDATE_RELOAD_FALLBACK_MS = 2000

export async function requestPwaUpdateReload(
    updateSW: ((reloadPage?: boolean) => Promise<void>) | null | undefined,
    options: {
        reloadPage?: () => void
        setTimeoutFn?: typeof setTimeout
        clearTimeoutFn?: typeof clearTimeout
    } = {},
): Promise<void> {
    const reloadPage = options.reloadPage ?? (() => window.location.reload())
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout

    if (!updateSW) {
        reloadPage()
        return
    }

    let reloaded = false
    const doReload = () => {
        if (reloaded) {
            return
        }
        reloaded = true
        reloadPage()
    }

    const onControllerChange = () => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        doReload()
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined

    try {
        await updateSW(true)
    } catch (error) {
        console.error('PWA update failed', error)
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        if (fallbackTimer !== undefined) {
            clearTimeoutFn(fallbackTimer)
        }
        doReload()
        return
    }

    fallbackTimer = setTimeoutFn(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        doReload()
    }, PWA_UPDATE_RELOAD_FALLBACK_MS)
}

export function setupRegistrationUpdateChecks(
    registration: ServiceWorkerRegistration,
): () => void {
    const intervalId = window.setInterval(() => {
        void registration.update()
    }, PWA_UPDATE_CHECK_INTERVAL_MS)

    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            void registration.update()
        }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
        window.clearInterval(intervalId)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
}

export function usePwaUpdate() {
    const [needRefresh, setNeedRefresh] = useState(false)
    const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null)
    const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
    const cleanupRef = useRef<(() => void) | null>(null)

    useEffect(() => {
        const updateSW = registerSW({
            onNeedRefresh() {
                setNeedRefresh(true)
            },
            onOfflineReady() {
                console.log('App ready for offline use')
            },
            onRegistered(registration) {
                cleanupRef.current?.()
                cleanupRef.current = null
                registrationRef.current = registration ?? null

                if (!registration) {
                    return
                }

                cleanupRef.current = setupRegistrationUpdateChecks(registration)
            },
            onRegisterError(error) {
                console.error('SW registration error:', error)
            },
        })

        updateSWRef.current = updateSW

        return () => {
            cleanupRef.current?.()
            cleanupRef.current = null
            updateSWRef.current = null
            registrationRef.current = null
        }
    }, [])

    const reload = useCallback(() => {
        void requestPwaUpdateReload(updateSWRef.current)
    }, [])

    // Force an immediate check against the server. Resolves true when a newer
    // service worker is now downloading/waiting (the update banner will follow
    // via onNeedRefresh); false when already current or SW unavailable.
    const checkForUpdate = useCallback(async (): Promise<boolean> => {
        const registration = registrationRef.current
        if (!registration) {
            return false
        }
        try {
            await registration.update()
        } catch {
            return false
        }
        return Boolean(registration.installing || registration.waiting)
    }, [])

    return { needRefresh, reload, checkForUpdate }
}
