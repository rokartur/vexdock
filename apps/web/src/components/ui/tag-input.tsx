import { type KeyboardEvent, type MouseEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { IconX } from '@tabler/icons-react'
import { AnimatePresence, motion, useAnimate, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

type TagInputProps = {
	label: string
	value?: string[]
	defaultValue?: string[]
	onValueChange?: (value: string[]) => void
	placeholder?: string
	description?: string
	id?: string
	// vexdock: tags already in use elsewhere, offered through the browser's own datalist.
	suggestions?: string[]
}

/**
 * Tags keep the field still: a new tag blurs in where its text was typed while the caret glides aside, a removed tag
 * leaves its slot and the rest glide in, and the shell follows wrapped rows on a spring. Backspace or the arrow keys
 * pick a tag first, a ring glides to it, and the next Backspace removes it.
 */
export function TagInput({
	label,
	value,
	defaultValue = [],
	onValueChange,
	placeholder = 'Add a tag',
	description,
	id,
	suggestions,
}: TagInputProps) {
	const generatedId = useId()
	const inputId = id ?? generatedId
	const hintId = description ? `${inputId}-description` : undefined
	const [internal, setInternal] = useState(defaultValue)
	const [draft, setDraft] = useState('')
	const [picked, setPicked] = useState<string | null>(null)
	const [notice, setNotice] = useState('')
	const reduced = useReducedMotion()
	const [scope, animate] = useAnimate<HTMLDivElement>()
	const contentRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const ringRef = useRef<HTMLSpanElement>(null)
	const ringAt = useRef('')
	const [height, setHeight] = useState<number | 'auto'>('auto')
	const tags = value ?? internal
	const active = picked !== null && tags.includes(picked) ? picked : null

	useEffect(() => {
		const node = contentRef.current
		if (!node) return
		const observer = new ResizeObserver(() => setHeight(node.offsetHeight))
		observer.observe(node)
		return () => observer.disconnect()
	}, [])

	// The ring measures the picked tag's resting box, glides between picks, and fades in place when the pick clears.
	useLayoutEffect(() => {
		const ring = ringRef.current
		const node =
			active === null
				? null
				: contentRef.current?.querySelector<HTMLElement>(`[data-tag="${CSS.escape(active)}"]`)
		if (!ring) return
		if (!node) {
			// Same curve as a removed tag, so a picked tag and its ring fade out as one piece.
			if (ringAt.current)
				animate(ring, reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }, {
					duration: reduced ? 0 : motionTokens.duration.instant,
					ease: motionTokens.ease.standard,
				})
			ringAt.current = ''
			return
		}
		const box = {
			x: node.offsetLeft,
			y: node.offsetTop,
			width: node.offsetWidth,
			height: node.offsetHeight,
		}
		const at = Object.values(box).join(' ')
		if (at === ringAt.current) return
		// A ring still fading from the last pick glides on to the next one, so quick Backspaces read as one motion.
		const gliding = ringAt.current !== '' || Number(getComputedStyle(ring).opacity) > 0.02
		if (!reduced && gliding)
			animate(
				ring,
				{ ...box, opacity: 1, scale: 1 },
				{ ...motionTokens.spring.morph, opacity: { duration: motionTokens.duration.fast } },
			)
		else
			animate(
				ring,
				{ ...box, opacity: [0, 1], scale: [reduced ? 1 : 0.9, 1] },
				reduced
					? { duration: 0, opacity: { duration: motionTokens.duration.instant } }
					: {
							duration: 0,
							opacity: { duration: motionTokens.duration.fast },
							scale: motionTokens.spring.snappy,
						},
			)
		ringAt.current = at
	})

	// A repeated message gets a trailing space, so the live region announces it again.
	function say(message: string) {
		setNotice(previous => (previous === message ? `${message}\u00A0` : message))
	}

	function update(next: string[]) {
		if (value === undefined) setInternal(next)
		onValueChange?.(next)
	}

	function pick(tag: string | null) {
		setPicked(tag)
		if (tag !== null) say(`${tag} selected. Press Backspace to remove it.`)
	}

	function add() {
		const tag = draft.trim()
		if (!tag) return
		const existing = tags.find(item => item.toLowerCase() === tag.toLowerCase())
		if (existing) {
			// A duplicate pulses the tag that already exists, so the ignored Enter still gets an answer.
			const node = scope.current.querySelector(`[data-tag="${CSS.escape(existing)}"]`)
			if (node && !reduced)
				animate(
					node,
					{ scale: [1, 1.06, 1] },
					{
						duration: motionTokens.duration.standard + motionTokens.duration.instant,
						ease: motionTokens.ease.inOut,
					},
				)
			say(`${existing} is already added`)
			return
		}
		update([...tags, tag])
		setDraft('')
		setPicked(null)
		say(`Added ${tag}`)
	}

	function remove(tag: string) {
		update(tags.filter(item => item !== tag))
		setPicked(null)
		say(`Removed ${tag}`)
		inputRef.current?.focus()
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		const { key, currentTarget: input } = event
		const atStart = input.selectionStart === 0 && input.selectionEnd === 0
		const index = active === null ? tags.length : tags.indexOf(active)
		const last = tags.at(-1)
		const previous = tags[index - 1]
		let handled = true
		if (key === 'Enter' || key === ',') add()
		else if ((key === 'Backspace' || key === 'Delete') && active !== null) remove(active)
		else if (key === 'Backspace' && atStart && last !== undefined) pick(last)
		else if (key === 'ArrowLeft' && (atStart || active !== null) && previous !== undefined) pick(previous)
		else if (key === 'ArrowRight' && active !== null) pick(tags[index + 1] ?? null)
		else if (key === 'Escape' && active !== null) pick(null)
		else handled = false
		if (handled) event.preventDefault()
	}

	// A click on a tag picks it without taking focus from the field. The remove button keeps its own press.
	function onTagPointer(event: MouseEvent<HTMLElement>, tag?: string) {
		if (event.target instanceof Element && event.target.closest('button')) return
		if (!tag) {
			event.preventDefault()
			return
		}
		pick(active === tag ? null : tag)
		inputRef.current?.focus()
	}

	const move = reduced ? { duration: 0 } : motionTokens.spring.morph
	const glide = reduced ? { duration: 0 } : motionTokens.spring.smooth

	return (
		<div className='grid w-full min-w-0'>
			<label className='mb-2 text-sm font-medium' htmlFor={inputId}>
				{label}
			</label>
			<motion.div
				ref={scope}
				className='box-content overflow-hidden rounded-control border border-border bg-surface transition-[border-color] duration-110 ease-standard focus-within:border-foreground hover:not-focus-within:border-border-strong'
				initial={false}
				animate={{ height }}
				transition={glide}
			>
				<div
					ref={contentRef}
					className='relative box-border flex min-h-[calc(var(--spacing-control-md)-2px)] cursor-text flex-wrap content-start items-center gap-1.5 p-[7px]'
					onClick={event => {
						if (event.target === event.currentTarget) inputRef.current?.focus()
					}}
				>
					{/* Above the pills and sized to the picked tag, so it glides between tags without scaling its border. */}
					<span
						ref={ringRef}
						className='pointer-events-none absolute top-0 left-0 z-1 box-border rounded-full border border-accent bg-accent-subtle opacity-0'
						aria-hidden='true'
					/>
					<AnimatePresence initial={false}>
						{!draft && !tags.length && (
							<motion.span
								key='placeholder'
								className='pointer-events-none absolute inset-0 flex items-center overflow-hidden px-3 text-sm whitespace-nowrap text-muted'
								aria-hidden='true'
								initial={
									reduced
										? { opacity: 0 }
										: { opacity: 0, y: '0.3em', filter: `blur(${motionTokens.blur.soft}px)` }
								}
								animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
								exit={{ opacity: 0, transition: { duration: 0 } }}
								transition={
									reduced
										? { duration: motionTokens.duration.instant }
										: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }
								}
							>
								{placeholder}
							</motion.span>
						)}
					</AnimatePresence>
					<AnimatePresence initial={false} mode='popLayout'>
						{tags.map(tag => (
							<motion.span
								layout={reduced ? false : 'position'}
								className='group/tag relative box-border inline-flex min-h-7 items-center gap-[3px] rounded-full border border-border bg-surface-muted pr-1 pl-[9px] text-sm whitespace-nowrap text-foreground'
								key={tag}
								data-tag={tag}
								data-picked={tag === active || undefined}
								onMouseDown={event => onTagPointer(event)}
								onClick={event => onTagPointer(event, tag)}
								initial={
									reduced
										? { opacity: 0 }
										: { opacity: 0, scale: 0.9, filter: `blur(${motionTokens.blur.soft}px)` }
								}
								// A resting tag ends its filter at none, so it is no stacking context and its label sits above the ring.
								animate={{
									opacity: 1,
									scale: 1,
									filter: 'blur(0px)',
									transitionEnd: { filter: 'none' },
								}}
								exit={
									reduced
										? { opacity: 0, transition: { duration: 0 } }
										: {
												opacity: 0,
												scale: 0.9,
												filter: `blur(${motionTokens.blur.subtle}px)`,
												transition: {
													duration: motionTokens.duration.instant,
													ease: motionTokens.ease.standard,
												},
											}
								}
								transition={
									reduced
										? { duration: motionTokens.duration.instant }
										: {
												...motionTokens.spring.morph,
												layout: move,
												opacity: {
													duration: motionTokens.duration.fast,
													ease: motionTokens.ease.enter,
												},
												filter: {
													duration: motionTokens.duration.standard,
													ease: motionTokens.ease.enter,
												},
											}
								}
							>
								<span className='relative z-2'>{tag}</span>
								<button
									type='button'
									className='relative z-2 grid size-[22px] place-items-center rounded-full bg-transparent text-secondary [transition:background-color_110ms_var(--ease-standard),color_110ms_var(--ease-standard),scale_400ms_var(--ease-spring)] group-data-picked/tag:text-foreground hover:bg-surface-muted hover:text-foreground focus-visible:bg-surface-muted focus-visible:text-foreground motion-safe:active:scale-96 motion-safe:active:[transition:background-color_110ms_var(--ease-standard),color_110ms_var(--ease-standard),scale_85ms_var(--ease-standard)]'
									onClick={() => remove(tag)}
									aria-label={`Remove ${tag}`}
								>
									<IconX size={14} stroke={1.75} aria-hidden='true' />
								</button>
							</motion.span>
						))}
					</AnimatePresence>
					<motion.input
						layout={reduced ? false : 'position'}
						transition={{ layout: move }}
						ref={inputRef}
						id={inputId}
						className='box-border min-h-7 min-w-20 flex-[1_1_100px] border-0 bg-transparent px-[5px] text-sm text-foreground placeholder:text-transparent'
						value={draft}
						onChange={event => {
							setDraft(event.currentTarget.value)
							setPicked(null)
						}}
						onKeyDown={onKeyDown}
						onBlur={() => {
							add()
							setPicked(null)
						}}
						placeholder={tags.length ? '' : placeholder}
						aria-describedby={hintId}
						list={suggestions ? `${inputId}-suggestions` : undefined}
					/>
					{suggestions && (
						<datalist id={`${inputId}-suggestions`}>
							{suggestions
								.filter(tag => !tags.includes(tag))
								.map(tag => (
									<option key={tag} value={tag} />
								))}
						</datalist>
					)}
				</div>
			</motion.div>
			<span className='sr-only' aria-live='polite'>
				{notice}
			</span>
			<FieldMessage id={hintId} text={description} />
		</div>
	)
}

function FieldMessage({ id, text }: { id?: string; text?: string }) {
	return (
		<AnimatePresence initial={false}>
			{text ? <MessageRow key='message' id={id} text={text} /> : null}
		</AnimatePresence>
	)
}

// The row tracks the measured copy, so a longer message that wraps opens its next line instead of snapping.
function MessageRow({ id, text }: { id?: string; text: string }) {
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
				className='block pt-2 text-xs text-muted'
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

// Changed words rise in and unblur while unchanged words hold still. Assistive tech reads the plain copy.
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
							key={`${index}:${word}`}
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
												duration: motionTokens.duration.instant,
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
							{index < words.length - 1 ? `${word} ` : word}
						</motion.span>
					))}
				</AnimatePresence>
			</span>
		</>
	)
}
