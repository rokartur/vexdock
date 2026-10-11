'use client'

import { useEffect, useRef, useState } from 'react'
import {
	AnimatePresence,
	animate,
	motion,
	type MotionValue,
	useMotionValue,
	useReducedMotion,
	useTransform,
} from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'

export interface AnimatedCounterProps {
	value: number
	prefix?: string
	suffix?: string
	decimals?: number
	className?: string
}

type Part = { key: string; digit: number } | { key: string; text: string }

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

/** Split a formatted number into columns keyed by place value, so 999 → 1,000 keeps the ones column the ones column. */
function partsFor(value: number, decimals: number): Part[] {
	const parts = new Intl.NumberFormat('en-US', {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
		numberingSystem: 'latn',
	}).formatToParts(value)
	let place = 0
	for (const part of parts) if (part.type === 'integer') place += part.value.length
	let fraction = 0
	return parts.flatMap((part, index): Part[] => {
		if (part.type === 'integer') return [...part.value].map(char => ({ key: `i${--place}`, digit: Number(char) }))
		if (part.type === 'fraction')
			return [...part.value].map(char => ({ key: `f${fraction++}`, digit: Number(char) }))
		const key = part.type === 'group' ? `g${place}` : part.type === 'decimal' ? 'd' : `${part.type}${index}`
		return [{ key, text: part.value }]
	})
}

/** One digit on the wheel. Its offset from the wheel position decides where it sits and how visible it is. */
function Glyph({ position, digit }: { position: MotionValue<number>; digit: number }) {
	const offset = useTransform(position, current => ((((digit - current) % 10) + 15) % 10) - 5)
	const y = useTransform(offset, current => `${current}em`)
	const opacity = useTransform(offset, current => Math.max(0, 1 - Math.abs(current)))
	const visibility = useTransform(offset, current => (Math.abs(current) >= 1 ? 'hidden' : 'visible'))
	const filter = useTransform(offset, current =>
		Math.abs(current) < 0.02 || Math.abs(current) >= 1
			? 'none'
			: `blur(${(Math.abs(current) * motionTokens.blur.subtle).toFixed(2)}px)`,
	)
	return (
		<motion.span
			className='absolute inset-x-0 inset-y-(--feather) text-center'
			style={{ y, opacity, filter, visibility }}
		>
			{digit}
		</motion.span>
	)
}

const presence = {
	initial: { width: 0, opacity: 0 },
	animate: { width: 'auto', opacity: 1 },
	exit: { width: 0, opacity: 0 },
}

/** A digit wheel. It always turns in the direction the whole number moved, wrapping 9 → 0 like an odometer. */
function Column({ digit, direction, reduceMotion }: { digit: number; direction: number; reduceMotion: boolean }) {
	const position = useMotionValue(digit)
	const wheel = useRef({ digit, target: digit })
	useEffect(() => {
		const state = wheel.current
		if (state.digit === digit) return
		state.target += direction < 0 ? -((state.digit - digit + 10) % 10) : (digit - state.digit + 10) % 10
		state.digit = digit
		if (reduceMotion) position.jump(state.target)
		else animate(position, state.target, motionTokens.spring.smooth)
	}, [digit, direction, position, reduceMotion])
	// The wheel's window reaches a little past the line box and feathers out, so a turning digit fades at the edge.
	return (
		<motion.span
			className='relative -my-(--feather) inline-block overflow-hidden mask-[linear-gradient(to_bottom,transparent,#000_calc(var(--feather)*1.5),#000_calc(100%-var(--feather)*1.5),transparent)] py-(--feather) [--feather:0.16em]'
			{...presence}
			transition={reduceMotion ? { duration: 0 } : motionTokens.spring.morph}
		>
			<span className='invisible'>0</span>
			{DIGITS.map(item => (
				<Glyph key={item} position={position} digit={item} />
			))}
		</motion.span>
	)
}

export function AnimatedCounter({ value, prefix = '', suffix = '', decimals = 0, className }: AnimatedCounterProps) {
	const reduceMotion = !!useReducedMotion()
	const [previous, setPrevious] = useState(value)
	const [direction, setDirection] = useState(1)
	if (value !== previous) {
		setPrevious(value)
		setDirection(value > previous ? 1 : -1)
	}
	const parts = partsFor(value, decimals)
	const text = `${prefix}${parts.map(part => ('text' in part ? part.text : part.digit)).join('')}${suffix}`
	return (
		<span
			className={cn(
				'relative inline-flex flex-col font-(family-name:--font-display) text-(length:--text-3xl) leading-none font-medium tracking-(--tracking-display) text-foreground tabular-nums',
				className,
			)}
		>
			<span className='sr-only'>{text}</span>
			<span className='inline-flex items-start whitespace-nowrap select-none' aria-hidden='true'>
				{prefix ? <span className='inline-block overflow-x-clip whitespace-pre'>{prefix}</span> : null}
				<AnimatePresence initial={false}>
					{parts.map(part =>
						'digit' in part ? (
							<Column
								key={part.key}
								digit={part.digit}
								direction={direction}
								reduceMotion={reduceMotion}
							/>
						) : (
							<motion.span
								key={part.key}
								className='inline-block overflow-x-clip'
								{...presence}
								transition={reduceMotion ? { duration: 0 } : motionTokens.spring.morph}
							>
								{part.text}
							</motion.span>
						),
					)}
				</AnimatePresence>
				{suffix ? <span className='inline-block overflow-x-clip whitespace-pre'>{suffix}</span> : null}
			</span>
		</span>
	)
}

export default AnimatedCounter
