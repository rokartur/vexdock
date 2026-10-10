'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import {
	AnimatePresence,
	animate,
	motion,
	useMotionValue,
	useReducedMotion,
	type AnimationPlaybackControls,
	type Transition,
} from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'
import { exitFast, fadeOut, iconIn, iconKey, shown, Swap, textIn, textOut } from './swap'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
	icon?: ReactNode
}

export function Badge({ icon, className, children, ...props }: BadgeProps) {
	const reduce = useReducedMotion()
	const text = typeof children === 'string' || typeof children === 'number' ? String(children) : null
	const glyphKey = icon ? iconKey(icon) : ''
	const body = useRef<HTMLSpanElement>(null)
	const content = useRef<HTMLSpanElement>(null)
	// Width stays auto at rest. Only a new label or icon springs it from the old size to the new one; passive reflows (a font swap, a hidden parent) follow instantly.
	const width = useMotionValue<number | 'auto'>('auto')
	const changedAt = useRef(0)
	useLayoutEffect(() => {
		changedAt.current = performance.now()
	}, [text, glyphKey])
	useEffect(() => {
		const node = content.current
		if (!node || typeof ResizeObserver === 'undefined') return
		let last: number | undefined
		let controls: AnimationPlaybackControls | undefined
		const settle = () => {
			width.jump('auto')
			if (body.current) body.current.style.width = 'auto'
		}
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return
			const next = entry.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth
			const current = width.get()
			const from = typeof current === 'number' ? current : last
			last = next
			controls?.stop()
			if (reduce || from === undefined || from === next || performance.now() - changedAt.current > 120)
				return settle()
			// Pin the old width before this frame paints, then spring to the new one.
			if (body.current) body.current.style.width = `${from}px`
			controls = animate(width, [from, next], { ...motionTokens.spring.morph, onComplete: settle })
		})
		observer.observe(node)
		return () => {
			observer.disconnect()
			controls?.stop()
		}
	}, [width, reduce])
	const enter: Transition = reduce
		? { duration: motionTokens.duration.instant }
		: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }
	const classes = cn(
		'inline-flex min-h-5 items-center overflow-clip rounded-full border border-border bg-(--surface-muted) px-2 text-xs/none font-medium tracking-[-0.01em] whitespace-nowrap text-(--text-secondary) transition-colors duration-(--duration-standard) ease-(--ease-standard) hover:border-[color-mix(in_oklab,var(--text-secondary)_32%,var(--border))] hover:bg-[color-mix(in_oklab,var(--text-secondary)_10%,var(--surface))] motion-reduce:duration-(--duration-instant)',
		className,
	)
	// The pill follows its content: text and icon swap in place while the width springs to the new size.
	return (
		<span {...props} className={classes}>
			<motion.span ref={body} className='block' style={{ width }}>
				<span ref={content} className='relative inline-flex w-max items-center gap-[5px]'>
					{icon ? (
						<span
							className='relative inline-flex flex-none items-center justify-center leading-none text-(--text-secondary) [&_svg]:size-3.5'
							aria-hidden='true'
						>
							<AnimatePresence mode='popLayout' initial={false}>
								<Swap
									key={glyphKey}
									className='relative inline-flex items-center'
									initial={reduce ? { opacity: 0 } : iconIn}
									animate={shown}
									exit={reduce ? fadeOut : { ...iconIn, transition: exitFast }}
									transition={reduce ? enter : motionTokens.spring.snappy}
								>
									{icon}
								</Swap>
							</AnimatePresence>
						</span>
					) : null}
					{text === null ? (
						children
					) : (
						<span className='relative inline-flex items-center'>
							<AnimatePresence mode='popLayout' initial={false}>
								<Swap
									key={text}
									className='block'
									initial={reduce ? { opacity: 0 } : textIn}
									animate={shown}
									exit={reduce ? fadeOut : textOut}
									transition={enter}
								>
									{text}
								</Swap>
							</AnimatePresence>
						</span>
					)}
				</span>
			</motion.span>
		</span>
	)
}

export default Badge
