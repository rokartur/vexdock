import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

/** `handlers` maps event names to callbacks. Unmounting closes the source, which stops the stream server-side too. */
export function useEventSource(url: string | null, handlers: Record<string, (data: unknown) => void>, enabled = true) {
	const [connected, setConnected] = useState(false)
	const [attempt, setAttempt] = useState(0)
	// Handlers change identity every render; a ref keeps the subscription stable.
	const handlersRef = useRef(handlers)
	handlersRef.current = handlers

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the reconnect trigger
	useEffect(() => {
		if (!url || !enabled) return
		const source = new EventSource(url, { withCredentials: true })
		const listeners: [string, EventListener][] = []
		let retry = 0

		source.onopen = () => setConnected(true)
		source.onerror = () => {
			setConnected(false)
			// The browser only retries a stream it managed to open. A non-200 (nginx
			// answering 502 while the manager restarts) closes the source for good,
			// and the dashboard would stop updating until a manual reload.
			if (source.readyState === EventSource.CLOSED) {
				retry = window.setTimeout(() => setAttempt(n => n + 1), 3000)
			}
		}

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
			clearTimeout(retry)
			for (const [name, listener] of listeners) source.removeEventListener(name, listener)
			source.close()
			setConnected(false)
		}
	}, [url, enabled, attempt])

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
	const pendingSince = useRef(0)

	// One `compose up` emits an event per container; coalesce the burst into a
	// single round of refetches. The 2s ceiling matters: a container in a crash
	// loop restarts faster than the debounce and would starve it forever.
	const refresh = () => {
		const now = Date.now()
		if (pendingSince.current === 0) pendingSince.current = now
		clearTimeout(timer.current)
		timer.current = window.setTimeout(
			() => {
				pendingSince.current = 0
				queryClient.invalidateQueries()
			},
			now - pendingSince.current >= 2000 ? 0 : 250,
		)
	}

	useEffect(() => () => clearTimeout(timer.current), [])
	return useEventSource('/api/system/events', Object.fromEntries(systemEvents.map(name => [name, refresh])))
}
