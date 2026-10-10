'use client'

import { isValidElement, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { animate, motion, useIsPresent, useMotionValue } from 'motion/react'
import type { AnimationPlaybackControls, HTMLMotionProps, TargetAndTransition, Transition } from 'motion/react'
import { motionTokens } from './motion-tokens'

/** Presets for copy and icons that swap in place: the new one rises in, the old one leaves upward. */
export const exitFast: Transition = { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] }
export const textIn: TargetAndTransition = { opacity: 0, y: '0.3em', filter: `blur(${motionTokens.blur.soft}px)` }
export const textOut: TargetAndTransition = {
	opacity: 0,
	y: '-0.3em',
	filter: `blur(${motionTokens.blur.subtle}px)`,
	transition: exitFast,
}
export const iconIn: TargetAndTransition = { opacity: 0, scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }
export const shown: TargetAndTransition = { opacity: 1, y: '0em', scale: 1, filter: 'blur(0px)' }
export const fadeOut: TargetAndTransition = { opacity: 0, transition: { duration: motionTokens.duration.instant } }

/** Outgoing copies are hidden from assistive tech while they fade, so the live region reads only the current text. */
export function Swap(props: HTMLMotionProps<'span'>) {
	const present = useIsPresent()
	return <motion.span {...props} aria-hidden={present ? props['aria-hidden'] : true} />
}

/** Names the icon element, so a new icon component crossfades in while re-rendering the same icon stays still. */
export function iconKey(icon: ReactNode) {
	if (!isValidElement(icon)) return 'icon'
	const type = icon.type as string | { displayName?: string; name?: string }
	return typeof type === 'string' ? type : (type.displayName ?? type.name ?? 'icon')
}

/** Follows its content height. After `morphKey` changes, the height springs from the old size to the new one and then returns to auto, so passive reflows (a
 * resize, a font swap) follow instantly. It clips only while moving, so focus rings stay visible at rest. */
export function HeightFrame({
	className,
	reduce,
	morphKey,
	children,
}: {
	className?: string
	reduce: boolean | null
	morphKey: string
	children: ReactNode
}) {
	const frame = useRef<HTMLDivElement>(null)
	const content = useRef<HTMLDivElement>(null)
	const height = useMotionValue<number | 'auto'>('auto')
	const changedAt = useRef(0)
	useLayoutEffect(() => {
		changedAt.current = performance.now()
	}, [morphKey])
	useEffect(() => {
		const node = content.current
		if (!node || typeof ResizeObserver === 'undefined') return
		let last: number | undefined
		let controls: AnimationPlaybackControls | undefined
		const settle = () => {
			height.jump('auto')
			if (frame.current) Object.assign(frame.current.style, { overflow: '', height: 'auto' })
		}
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return
			const next = entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight
			const current = height.get()
			const from = typeof current === 'number' ? current : last
			last = next
			controls?.stop()
			if (reduce || from === undefined || from === next || performance.now() - changedAt.current > 120)
				return settle()
			// Pin the old height before this frame paints, then spring to the new one.
			if (frame.current) Object.assign(frame.current.style, { overflow: 'hidden', height: `${from}px` })
			controls = animate(height, [from, next], { ...motionTokens.spring.smooth, onComplete: settle })
		})
		observer.observe(node)
		return () => {
			observer.disconnect()
			controls?.stop()
		}
	}, [height, reduce])
	return (
		<motion.div ref={frame} className={className} style={{ height }}>
			<div ref={content} className='relative flow-root'>
				{children}
			</div>
		</motion.div>
	)
}
