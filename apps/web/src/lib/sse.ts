import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

/**
 * Subscribe to one of the manager's SSE endpoints.
 *
 * `handlers` maps event names to callbacks. The subscription is torn down on
 * unmount, so leaving a log view stops the stream server-side too.
 */
export function useEventSource(url: string | null, handlers: Record<string, (data: unknown) => void>, enabled = true) {
	const [connected, setConnected] = useState(false)
	// Handlers change identity every render; a ref keeps the subscription stable.
	const handlersRef = useRef(handlers)
	handlersRef.current = handlers

	useEffect(() => {
		if (!url || !enabled) return
		const source = new EventSource(url, { withCredentials: true })
		const listeners: [string, EventListener][] = []

		source.onopen = () => setConnected(true)
		source.onerror = () => setConnected(false)

		for (const name of Object.keys(handlersRef.current)) {
			const listener: EventListener = event => {
				const message = event as MessageEvent<string>
				try {
					handlersRef.current[name]?.(message.data ? JSON.parse(message.data) : null)
				} catch {
					handlersRef.current[name]?.(message.data)
				}
			}
			source.addEventListener(name, listener)
			listeners.push([name, listener])
		}

		return () => {
			for (const [name, listener] of listeners) source.removeEventListener(name, listener)
			source.close()
			setConnected(false)
		}
	}, [url, enabled])

	return connected
}

/**
 * Every event the manager publishes on `/api/system/events`. Mirrors the
 * publish sites in `deployments/engine.go` and `events/reconciler.go`;
 * EventSource has no wildcard, so a new server-side event has to be listed
 * here to reach the panel.
 */
const systemEvents = [
	'deployment.queued',
	'deployment.success',
	'deployment.failed',
	'deployment.cancelled',
	'container.start',
	'container.die',
	'container.stop',
	'container.destroy',
	'container.health_status: healthy',
	'container.health_status: unhealthy',
]

/**
 * Refetch the mounted queries whenever Docker or a deployment actually moves.
 * Mount this once, at the top of the authenticated tree: it is what replaces
 * per-page `refetchInterval` for everything the server can tell us about.
 */
export function useSystemEvents() {
	const queryClient = useQueryClient()
	// 0 is never a live handle, so it doubles as "nothing scheduled".
	const timer = useRef(0)

	// One `compose up` emits an event per container; coalesce the burst into a
	// single round of refetches.
	const refresh = () => {
		clearTimeout(timer.current)
		timer.current = window.setTimeout(() => queryClient.invalidateQueries(), 250)
	}

	useEffect(() => () => clearTimeout(timer.current), [])
	return useEventSource('/api/system/events', Object.fromEntries(systemEvents.map(name => [name, refresh])))
}
