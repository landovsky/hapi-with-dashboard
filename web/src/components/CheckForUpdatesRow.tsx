import { useState } from 'react'
import { usePwaUpdateContext } from '@/lib/pwa-update-context'

/**
 * On-demand "get the fresh version without reinstalling the PWA" button. Forces
 * a service-worker update check; if a newer build is waiting it activates it and
 * reloads (via the shared usePwaUpdate reload flow), otherwise it confirms the
 * app is current. Lives in the Settings → About section.
 */
export function CheckForUpdatesRow() {
    const { checkForUpdate, reload } = usePwaUpdateContext()
    const [state, setState] = useState<'idle' | 'checking' | 'current'>('idle')

    const onCheck = async () => {
        setState('checking')
        const found = await checkForUpdate()
        if (found) {
            // Activate the waiting worker + reload to the fresh build.
            reload()
            return
        }
        setState('current')
        window.setTimeout(() => setState('idle'), 3000)
    }

    const label = state === 'checking'
        ? 'Checking…'
        : state === 'current'
            ? 'Up to date ✓'
            : 'Check for updates'

    return (
        <div className="flex w-full items-center justify-between px-3 py-3">
            <span className="text-[var(--app-fg)]">Updates</span>
            <button
                type="button"
                onClick={() => void onCheck()}
                disabled={state === 'checking'}
                className="text-[var(--app-link)] hover:underline disabled:opacity-60"
            >
                {label}
            </button>
        </div>
    )
}
