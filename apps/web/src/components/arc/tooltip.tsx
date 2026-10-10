'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'

export interface TooltipProps {
	content: ReactNode
	children: ReactElement
	side?: 'top' | 'bottom' | 'left' | 'right'
}

/** One for the app (in __root.tsx): within `timeout` after a tooltip closes, the next opens with `data-instant`, without delay or travel. */
export function TooltipProvider({ children }: { children: ReactNode }) {
	return (
		<TooltipPrimitive.Provider delay={250} timeout={300}>
			{children}
		</TooltipPrimitive.Provider>
	)
}
/** String content crossfades when it changes while open, and the bubble springs to the new text size. */
function TooltipText({ text }: { text: string }) {
	const reduced = useReducedMotion()
	const measure = useRef<HTMLSpanElement>(null)
	const measured = useRef<string | null>(null)
	const [size, setSize] = useState<{ width: number; height: number; animate: boolean } | null>(null)
	useLayoutEffect(() => {
		const node = measure.current
		if (!node) return
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return
			const box = entry.borderBoxSize?.[0]
			const current = node.textContent
			const animate = measured.current !== null && measured.current !== current
			measured.current = current
			setSize({
				width: Math.ceil(box?.inlineSize ?? node.offsetWidth),
				height: Math.ceil(box?.blockSize ?? node.offsetHeight),
				animate,
			})
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	return (
		<motion.span
			className='relative block overflow-clip [overflow-clip-margin:var(--space-2)]'
			initial={false}
			animate={size ? { width: size.width, height: size.height } : undefined}
			transition={size?.animate && !reduced ? motionTokens.spring.morph : { duration: 0 }}
		>
			<span
				ref={measure}
				className='pointer-events-none invisible absolute top-0 left-0 w-max max-w-[calc(15rem-1.5rem-2px)]'
				aria-hidden='true'
			>
				{text}
			</span>
			<AnimatePresence mode='popLayout' initial={false}>
				<motion.span
					key={text}
					className='block w-max max-w-[calc(15rem-1.5rem-2px)]'
					initial={reduced ? false : { opacity: 0, y: '0.3em', filter: `blur(${motionTokens.blur.soft}px)` }}
					animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
					exit={
						reduced
							? { opacity: 0, transition: { duration: 0 } }
							: {
									opacity: 0,
									y: '-0.3em',
									filter: `blur(${motionTokens.blur.subtle}px)`,
									transition: {
										duration: motionTokens.duration.instant,
										ease: [...motionTokens.ease.standard],
									},
								}
					}
					transition={{ duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}
				>
					{text}
				</motion.span>
			</AnimatePresence>
		</motion.span>
	)
}

export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
	return (
		<TooltipPrimitive.Root>
			{/* render: the child is the control (a button, a link); a Trigger <button> around it would nest buttons. */}
			<TooltipPrimitive.Trigger render={children} />
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Positioner className='z-90' side={side} sideOffset={8} collisionPadding={12}>
					<TooltipPrimitive.Popup
						// The first tooltip waits, then rises a few pixels from its trigger; within the skip window the next
						// one only fades. Transitions, so returning while it fades out reverses the fade instead of restarting.
						className={cn(
							'max-w-60 origin-(--transform-origin) rounded-(--radius-control) border border-[color-mix(in_oklab,var(--background)_14%,var(--foreground))] bg-foreground px-3 py-1.5 text-xs/(--leading-body) font-normal text-background shadow-(--shadow-raised) [--tooltip-y:3px] [transition:opacity_var(--duration-instant)_var(--ease-enter),transform_var(--duration-instant)_var(--ease-enter)] data-[side=bottom]:[--tooltip-y:-3px]',
							'data-starting-style:[transform:translateY(var(--tooltip-y))_scale(0.97)] data-starting-style:opacity-0 data-instant:data-starting-style:[transform:none]',
							'data-instant:[transition:opacity_var(--duration-instant)_var(--ease-standard),transform_var(--duration-instant)_var(--ease-standard)]',
							'data-ending-style:[transform:scale(0.98)] data-ending-style:opacity-0 data-ending-style:[transition:opacity_var(--duration-instant)_var(--ease-standard),transform_var(--duration-instant)_var(--ease-standard)]',
							'motion-reduce:[transform:none]! motion-reduce:[transition:opacity_var(--duration-instant)_var(--ease-standard)]!',
						)}
					>
						{typeof content === 'string' || typeof content === 'number' ? (
							<TooltipText text={String(content)} />
						) : (
							content
						)}
					</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	)
}

export default Tooltip
