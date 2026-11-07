import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

type StreamState = 'connecting' | 'open' | 'lost'

/** `handlers` maps event names to callbacks. Unmounting closes the source, which stops the stream server-side too.
 * Returns `lost` after an error until the source opens again; the browser or the timer below keeps retrying. While no
 * stream is wanted (`url` null or `enabled` false) it reads `connecting`, the state the next one starts in. */
export function useEventSource(url: string | null, handlers: Record<string, (data: unknown) => void>, enabled = true) {
	const [state, setState] = useState<StreamState>('connecting')
	// A new stream, or the same one switched back on, starts over during render; a retry of the same one keeps `lost`,
	// so a warning shown for it does not blink every 3s.
	const [stream, setStream] = useState({ url, enabled })
	if (stream.url !== url || stream.enabled !== enabled) {
		setStream({ url, enabled })
		setState('connecting')
	}
	const [attempt, setAttempt] = useState(0)
	// Handlers change identity every render; a ref keeps the subscription stable.
	const handlersRef = useRef(handlers)
	handlersRef.current = handlers

	// `attempt` is never read inside: bumping it is what reopens a source the browser gave up on.
	useEffect(() => {
		if (!url || !enabled) return
		const source = new EventSource(url, { withCredentials: true })
		const listeners: [string, EventListener][] = []
		let retry = 0

		source.onopen = () => setState('open')
		source.onerror = () => {
			setState('lost')
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
				let payload: unknown = message.data
				try {
					payload = message.data ? JSON.parse(message.data) : null
				} catch {
					// A plain-text event (a log line) is handed over as the string it is.
				}
				handlersRef.current[name]?.(payload)
			}
			source.addEventListener(name, listener)
			listeners.push([name, listener])
		}

		return () => {
			clearTimeout(retry)
			for (const [name, listener] of listeners) source.removeEventListener(name, listener)
			source.close()
		}
	}, [url, enabled, attempt])

	return url && enabled ? state : 'connecting'
}

/**
 * Mirrors the publish sites in `deployments/mod.rs` and `events/reconciler.rs`. EventSource has no wildcard, so an
 * event missing from this list never reaches the panel.
 */
const systemEvents = [
	'deployment.queued',
	'deployment.started',
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
	// Events published while the stream was down are gone, so every open after the first refetches what they changed.
	const opened = useRef(false)
	const reopen = () => {
		if (opened.current) refresh()
		opened.current = true
	}
	return useEventSource('/api/system/events', {
		...Object.fromEntries(systemEvents.map(name => [name, refresh])),
		open: reopen,
	})
}
