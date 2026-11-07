import { useEffect } from 'react'

/**
 * A control that removes itself (a row's Delete, Cancel deployment, Clear selection) takes focus down with it, and the
 * browser drops focus on <body>. This hands it to the nearest place still on screen: the open dialog, a marked
 * `data-focus-fallback` (a table's scroll box), the section's heading, then the page's main region.
 */
export function useFocusRescue() {
	useEffect(() => {
		let focused: Element | null = null
		let fallbacks: HTMLElement[] = []

		const remember = (event: FocusEvent) => {
			if (!(event.target instanceof Element)) return
			focused = event.target
			fallbacks = [
				event.target.closest('[role="dialog"]'),
				event.target.closest('[data-focus-fallback]'),
				event.target.closest('section')?.querySelector('h2, h3'),
				event.target.closest('section'),
				event.target.closest('main'),
			].filter(candidate => candidate instanceof HTMLElement)
		}

		const rescue = () => {
			if (!focused || focused.isConnected) return
			if (document.activeElement && document.activeElement !== document.body) return
			focused = null
			const target = fallbacks.find(candidate => candidate.isConnected)
			if (!target) return
			if (!target.hasAttribute('tabindex')) target.tabIndex = -1
			target.focus({ preventScroll: true })
		}

		document.addEventListener('focusin', remember)
		const observer = new MutationObserver(rescue)
		observer.observe(document.body, { childList: true, subtree: true })
		return () => {
			document.removeEventListener('focusin', remember)
			observer.disconnect()
		}
	}, [])
}
