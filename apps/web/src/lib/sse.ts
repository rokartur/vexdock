import { useEffect, useRef, useState } from 'react'

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
