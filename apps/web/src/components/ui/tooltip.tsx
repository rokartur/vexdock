import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import { cn } from 'cn'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export interface TooltipProps {
	content: ReactNode
	children: ReactElement
	side?: 'top' | 'bottom' | 'left' | 'right'
}

const DELAY = 250
const SKIP_WINDOW = 300

// Each Tooltip stands alone, so the skip window is shared here: while any tooltip is open, and 300ms after the last closes, the next opens without delay or travel.
let warm = false
let openCount = 0
let coolTimer = 0
const listeners = new Set<() => void>()
const warmth = {
	subscribe(listener: () => void) {
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	},
	get: () => warm,
	set(next: boolean) {
		if (warm === next) return
		warm = next
		listeners.forEach(listener => listener())
	},
	opened() {
		openCount += 1
		window.clearTimeout(coolTimer)
		warmth.set(true)
	},
	closed() {
		openCount = Math.max(0, openCount - 1)
		if (openCount) return
		window.clearTimeout(coolTimer)
		coolTimer = window.setTimeout(() => warmth.set(false), SKIP_WINDOW)
	},
}

export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
	const isWarm = useSyncExternalStore(warmth.subscribe, warmth.get, () => false)
	const [open, setOpen] = useState(false)
	const [instant, setInstant] = useState(false)
	const popupId = useId()
	const pressing = useRef(false)
	useEffect(() => {
		if (!open) return
		warmth.opened()
		return warmth.closed
	}, [open])
	return (
		<BaseTooltip.Root
			open={open}
			onOpenChange={next => {
				if (next) setInstant(warmth.get())
				setOpen(next)
			}}
		>
			<BaseTooltip.Trigger
				render={children}
				delay={isWarm ? 0 : DELAY}
				aria-describedby={open ? popupId : undefined}
				onPointerDown={() => {
					pressing.current = true
					window.addEventListener('pointerup', () => (pressing.current = false), { once: true })
				}}
				// Base UI opens on :focus-visible only; Arc's Radix tooltip also opens when code moves focus here after a click elsewhere.
				onFocus={event => {
					if (pressing.current || event.currentTarget.matches(':focus-visible')) return
					setInstant(warmth.get())
					setOpen(true)
				}}
			/>
			<BaseTooltip.Portal>
				<BaseTooltip.Positioner className='z-90' side={side} sideOffset={8} collisionPadding={12}>
					<BaseTooltip.Popup
						id={popupId}
						role='tooltip'
						className={cn(
							'max-w-60 origin-(--transform-origin) rounded-control border border-[color-mix(in_oklab,var(--background)_14%,var(--foreground))] bg-foreground px-3 py-2.5 text-sm font-normal text-background shadow-raised',
							'transition-[opacity,translate,scale] data-ending-style:opacity-0 data-ending-style:duration-85 data-ending-style:ease-standard data-starting-style:opacity-0 motion-safe:data-ending-style:scale-98',
							instant
								? 'duration-85 ease-standard'
								: 'duration-110 ease-enter motion-safe:data-starting-style:translate-y-[3px] motion-safe:data-starting-style:scale-97 motion-safe:data-[side=bottom]:data-starting-style:-translate-y-[3px]',
						)}
					>
						{typeof content === 'string' || typeof content === 'number' ? (
							<TooltipText text={String(content)} closing={!open} />
						) : (
							content
						)}
					</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	)
}

// String content crossfades when it changes while open, and the bubble springs to the new text size.
// While closing it swaps at once, as Arc's Radix tooltip remounts its content and fades out at the new width.
function TooltipText({ text, closing }: { text: string; closing: boolean }) {
	const reduced = useReducedMotion() || closing
	const measure = useRef<HTMLSpanElement>(null)
	const measured = useRef<string | null>(null)
	const [size, setSize] = useState<{ width: number; height: number; animate: boolean } | null>(null)
	useLayoutEffect(() => {
		const node = measure.current
		if (!node) return
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return
			const box = entry.borderBoxSize[0]!
			const current = node.textContent
			const animate = measured.current !== null && measured.current !== current
			measured.current = current
			setSize({ width: Math.ceil(box.inlineSize), height: Math.ceil(box.blockSize), animate })
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	return (
		<motion.span
			className='relative block overflow-clip [overflow-clip-margin:6px]'
			initial={false}
			animate={size ? { width: size.width, height: size.height } : undefined}
			transition={size?.animate && !reduced ? motionTokens.spring.morph : { duration: 0 }}
		>
			<span
				ref={measure}
				className='pointer-events-none invisible absolute top-0 left-0 w-max max-w-[calc(15rem-26px)]'
				aria-hidden='true'
			>
				{text}
			</span>
			<AnimatePresence mode='popLayout' initial={false}>
				<motion.span
					key={text}
					className='block w-max max-w-[calc(15rem-26px)]'
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
					transition={{
						duration: motionTokens.duration.standard,
						ease: [...motionTokens.ease.enter],
					}}
				>
					{text}
				</motion.span>
			</AnimatePresence>
		</motion.span>
	)
}
