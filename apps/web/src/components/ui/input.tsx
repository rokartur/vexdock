import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { cn } from 'cn'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

type InputProps = ComponentProps<'input'> & {
	label: string
	description?: string
	error?: string
	// vexdock: keeps the label for assistive tech only, for a control in a table row or a toolbar.
	hideLabel?: boolean
}

export function Input({ label, description, error, hideLabel, id, className, ...props }: InputProps) {
	const generatedId = useId()
	const controlId = id ?? generatedId
	const hintId = description ? `${controlId}-description` : undefined
	const errorId = error ? `${controlId}-error` : undefined
	const describedBy = [props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined
	return (
		<div className='grid min-w-0'>
			<label
				className={cn('mb-2 text-sm font-medium text-foreground', hideLabel && 'sr-only')}
				htmlFor={controlId}
			>
				{label}
			</label>
			<input
				{...props}
				id={controlId}
				className={cn(
					'min-h-control-md w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground transition-[border-color,background-color] placeholder:text-muted not-aria-invalid:hover:border-foreground focus-visible:border-foreground disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-50 aria-invalid:border-danger',
					className,
				)}
				aria-invalid={error ? true : props['aria-invalid']}
				aria-describedby={describedBy}
			/>
			<FieldMessage id={hintId} text={description} className='text-muted' />
			<FieldMessage id={errorId} text={error} className='text-danger' alert />
		</div>
	)
}

type FieldMessageProps = { id?: string; text?: string; className: string; alert?: boolean }

function FieldMessage({ text, ...rest }: FieldMessageProps) {
	return (
		<AnimatePresence initial={false}>
			{text ? <MessageRow key='message' text={text} {...rest} /> : null}
		</AnimatePresence>
	)
}

// The row tracks the measured copy, so a longer message that wraps opens its next line instead of snapping.
function MessageRow({ id, text, className, alert }: FieldMessageProps & { text: string }) {
	const reduced = useReducedMotion()
	const copyRef = useRef<HTMLSpanElement>(null)
	const [height, setHeight] = useState<number | 'auto'>('auto')
	useEffect(() => {
		const node = copyRef.current
		if (!node) return
		const observer = new ResizeObserver(entries => {
			for (const entry of entries) setHeight(entry.borderBoxSize[0]!.blockSize)
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	// Reduced motion mounts the row at full height: a zero-duration open would still paint one collapsed frame.
	return (
		<motion.span
			className='block overflow-hidden'
			initial={reduced ? false : { height: 0, opacity: 0 }}
			animate={{ height, opacity: 1 }}
			exit={{
				height: 0,
				opacity: 0,
				transition: reduced
					? { duration: 0 }
					: {
							height: motionTokens.spring.smooth,
							opacity: { duration: motionTokens.duration.instant },
						},
			}}
			transition={
				reduced
					? { duration: 0 }
					: {
							height: motionTokens.spring.smooth,
							opacity: { duration: motionTokens.duration.fast },
						}
			}
		>
			<motion.span
				ref={copyRef}
				id={id}
				className={cn('block pt-2 text-xs', className)}
				role={alert ? 'alert' : undefined}
				initial={reduced ? false : { y: '0.35em', filter: `blur(${motionTokens.blur.soft}px)` }}
				animate={{ y: 0, filter: 'blur(0px)' }}
				transition={{
					duration: reduced ? 0 : motionTokens.duration.standard,
					ease: motionTokens.ease.enter,
				}}
			>
				<MotionText text={text} />
			</motion.span>
		</motion.span>
	)
}

// Changed words rise in and unblur while unchanged words hold still, and numbers roll. Assistive tech reads the plain copy.
function MotionText({ text }: { text: string }) {
	const reduced = useReducedMotion()
	const words = text.split(' ')
	return (
		<>
			<span className='sr-only'>{text}</span>
			{/* Words that pop out to leave are measured against this box, so it must be the positioned parent. */}
			<span className='relative block' aria-hidden='true'>
				<AnimatePresence initial={false} mode='popLayout'>
					{words.map((word, index) => (
						<motion.span
							key={`${index}:${isNumber(word) ? '#' : word}`}
							className='inline-block whitespace-pre'
							initial={
								reduced
									? { opacity: 0 }
									: { opacity: 0, y: '0.35em', filter: `blur(${motionTokens.blur.soft}px)` }
							}
							animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
							exit={
								reduced
									? { opacity: 0, transition: { duration: 0 } }
									: {
											opacity: 0,
											y: '-0.35em',
											filter: `blur(${motionTokens.blur.subtle}px)`,
											transition: {
												duration: motionTokens.duration.exit,
												ease: motionTokens.ease.standard,
											},
										}
							}
							transition={
								reduced
									? { duration: motionTokens.duration.instant }
									: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }
							}
						>
							{isNumber(word) ? <RollingNumber word={word} /> : word}
							{index < words.length - 1 ? ' ' : null}
						</motion.span>
					))}
				</AnimatePresence>
			</span>
		</>
	)
}

// Digits roll up when a number grows and down when it shrinks; `custom` hands the latest direction to digits already leaving.
const digit = {
	enter: (direction: number) => ({
		opacity: 0,
		y: `${direction * 0.6}em`,
		filter: `blur(${motionTokens.blur.subtle}px)`,
	}),
	center: { opacity: 1, y: 0, filter: 'blur(0px)' },
	exit: (direction: number) => ({
		opacity: 0,
		y: `${direction * -0.6}em`,
		filter: `blur(${motionTokens.blur.subtle}px)`,
	}),
}

// A count in the copy, such as "12 characters", rolls only the digits that changed; a gained or lost digit opens or closes its width.
function RollingNumber({ word }: { word: string }) {
	const reduced = useReducedMotion()
	const [shown, setShown] = useState({ word, direction: 1 })
	if (shown.word !== word) {
		setShown({ word, direction: numericValue(word) < numericValue(shown.word) ? -1 : 1 })
	}
	const characters = word.split('')
	const transition = reduced
		? { duration: 0 }
		: {
				y: motionTokens.spring.snappy,
				width: motionTokens.spring.morph,
				opacity: { duration: motionTokens.duration.fast },
				filter: { duration: motionTokens.duration.fast },
			}
	return (
		<AnimatePresence initial={false}>
			{characters.map((character, index) => (
				// Tabular digits keep columns equal, so only a gained or lost digit changes the width.
				<motion.span
					key={characters.length - index}
					className='relative inline-flex justify-center tabular-nums'
					initial={{ width: 0, opacity: 0 }}
					animate={{ width: 'auto', opacity: 1 }}
					exit={{ width: 0, opacity: 0 }}
					transition={transition}
				>
					<AnimatePresence initial={false} mode='popLayout' custom={shown.direction}>
						<motion.span
							key={character}
							className='inline-block'
							custom={shown.direction}
							variants={digit}
							initial='enter'
							animate='center'
							exit='exit'
							transition={transition}
						>
							{character}
						</motion.span>
					</AnimatePresence>
				</motion.span>
			))}
		</AnimatePresence>
	)
}

function isNumber(word: string) {
	return /^\d[\d.,/:]*%?$/.test(word)
}

function numericValue(word: string) {
	return Number.parseFloat(word.replaceAll(',', ''))
}
