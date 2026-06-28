import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'

/**
 * Sessions for the dashboard, filtered on the backend to the last few days
 * unless `showAll` is set. Polls so the board stays live; `total` lets the UI
 * show how many were hidden by the window.
 */
export function useDashboardSessions(api: ApiClient | null, showAll: boolean): {
    sessions: SessionSummary[]
    total: number
    shown: number
    days: number
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        // `showAll` is part of the key so toggling refetches rather than serving
        // the stale filtered set.
        queryKey: ['dashboard', 'sessions', { all: showAll }],
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getDashboardSessions({ all: showAll })
        },
        enabled: Boolean(api),
        refetchInterval: 10_000
    })

    return {
        sessions: query.data?.sessions ?? [],
        total: query.data?.total ?? 0,
        shown: query.data?.shown ?? 0,
        days: query.data?.days ?? 5,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch
    }
}
