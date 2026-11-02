import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from 'cn'
import { animate, motion, useMotionValue, useReducedMotion, type Transition } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type SwitchProps = Omit<ComponentProps<typeof SwitchPrimitive.Root>, 'className'> & {
	label?: string
	className?: string
}

// Track inner width (42 - 6 padding) minus the 18px thumb.
const size = 18
const travel = 18
const stretch = 5
// Critically damped: the thumb lands on its end without overshooting the state it reports.
const glide: Transition = { type: 'spring', visualDuration: 0.21, bounce: 0 }

export function Switch({
	label,
	className,
	checked,
	defaultChecked,
	onCheckedChange,
	onPointerDown,
	onPointerUp,
	onPointerLeave,
	onPointerCancel,
	onKeyDown,
	onKeyUp,
	onBlur,
	...props
}: SwitchProps) {
	const reduceMotion = useReducedMotion()
	const [internal, setInternal] = useState(defaultChecked ?? false)
	const [pressed, setPressed] = useState(false)
	const on = checked ?? internal
	const scaleX = useMotionValue(1)
	const shown = useRef(on)
	// A pointer or Space press already stretched the thumb, so its release adds no second stretch.
	const releasedAt = useRef(-Infinity)

	useEffect(() => {
		if (shown.current === on) return
		shown.current = on
		const fromPress = performance.now() - releasedAt.current < 250
		if (reduceMotion || fromPress) return
		const controls = animate(scaleX, [1, 1.16, 1], {
			duration: 0.24,
			times: [0, 0.4, 1],
			ease: ['easeOut', 'easeInOut'],
		})
		return () => controls.stop()
	}, [on, reduceMotion, scaleX])

	const extra = pressed && !reduceMotion && !props.disabled ? stretch : 0

	return (
		<SwitchPrimitive.Root
			{...props}
			checked={on}
			onCheckedChange={(next, eventDetails) => {
				if (checked === undefined) setInternal(next)
				onCheckedChange?.(next, eventDetails)
			}}
			onPointerDown={event => {
				onPointerDown?.(event)
				if (event.button === 0) setPressed(true)
			}}
			onPointerUp={event => {
				onPointerUp?.(event)
				if (pressed && !props.disabled) releasedAt.current = performance.now()
				setPressed(false)
			}}
			onPointerLeave={event => {
				onPointerLeave?.(event)
				setPressed(false)
			}}
			onPointerCancel={event => {
				onPointerCancel?.(event)
				setPressed(false)
			}}
			onKeyDown={event => {
				onKeyDown?.(event)
				if (event.key === ' ') setPressed(true)
			}}
			onKeyUp={event => {
				onKeyUp?.(event)
				if (pressed && !props.disabled) releasedAt.current = performance.now()
				setPressed(false)
			}}
			onBlur={event => {
				onBlur?.(event)
				setPressed(false)
			}}
			nativeButton
			render={<button type='button' />}
			className={cn(
				'group/switch inline-flex min-h-control-md items-center gap-2.5 text-sm text-foreground [-webkit-tap-highlight-color:transparent] disabled:opacity-50',
				className,
			)}
			aria-label={props['aria-label'] ?? label}
		>
			{/* Fixed box: the thumb moves inside it with transforms, so nothing around the switch shifts.
          transition-none under reduced motion as in Arc: the kill switch's 0.01ms paints one stale-color frame. */}
			<span className="relative isolate flex h-6 w-[42px] shrink-0 items-center rounded-full bg-control-track p-[3px] transition-[background-color] duration-110 ease-standard group-hover/switch:group-data-unchecked/switch:bg-control-track-hover before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:bg-control-on before:opacity-0 before:transition-opacity before:duration-170 before:ease-standard before:content-[''] group-data-checked/switch:before:opacity-100 motion-reduce:transition-none motion-reduce:before:transition-none">
				{/* The thumb stretches like a held finger and keeps its far edge anchored, then travels on a spring. */}
				<motion.span
					className='size-[18px] shrink-0 rounded-full bg-control-thumb shadow-thumb transition-[background-color] duration-170 ease-standard will-change-transform group-data-checked/switch:bg-control-thumb-on motion-reduce:transition-none'
					style={{ scaleX }}
					initial={false}
					animate={{ x: on ? travel - extra : 0, width: size + extra }}
					transition={reduceMotion ? { duration: 0 } : { x: glide, width: motionTokens.spring.snappy }}
				/>
			</span>
			{label ? <span>{label}</span> : null}
		</SwitchPrimitive.Root>
	)
}
