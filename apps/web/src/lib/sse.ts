import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

/** `handlers` maps event names to callbacks. Unmounting closes the source, which stops the stream server-side too. */
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
 * Mirrors the publish sites in `deployments/engine.go` and `events/reconciler.go`. EventSource has no wildcard, so an
 * event missing from this list never reaches the panel.
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

/** Mounted once at the top of the authenticated tree, where it replaces per-page `refetchInterval`. */
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
