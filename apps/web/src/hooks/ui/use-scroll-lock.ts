import { useEffect } from 'react'

const POPOVER_OPEN_ATTR = 'data-popover-open'
let lockCount = 0

export function useScrollLock(active: boolean) {
	useEffect(() => {
		if (!active) return
		lockCount += 1
		if (lockCount === 1) {
			document.documentElement.setAttribute(POPOVER_OPEN_ATTR, '')
		}
		return () => {
			lockCount = Math.max(0, lockCount - 1)
			if (lockCount === 0) {
				document.documentElement.removeAttribute(POPOVER_OPEN_ATTR)
			}
		}
	}, [active])
}
