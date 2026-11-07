import { type ChangeEvent, type DragEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import {
	IconCloudUpload,
	IconFile,
	IconFileText,
	IconFileZip,
	IconPhoto,
	IconRotateClockwise,
	IconX,
} from '@tabler/icons-react'
import { cn } from 'cn'
import {
	AnimatePresence,
	animate,
	type HTMLMotionProps,
	motion,
	type MotionProps,
	type TargetAndTransition,
	type Transition,
	useIsPresent,
	useMotionValue,
	useMotionValueEvent,
	useReducedMotion,
	useTransform,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type FileUploadItem = { id: string; file: File; error?: string }

type FileUploadProps = {
	accept?: string
	disabled?: boolean
	label?: string
	description?: string
	multiple?: boolean
	maxSize?: number
	value?: FileUploadItem[]
	onChange?: (files: FileUploadItem[]) => void
	onUpload?: (file: File, options: { onProgress: (percent: number) => void; signal: AbortSignal }) => Promise<void>
}

type Upload = { status: 'uploading' | 'done' | 'failed'; progress: number }

const { blur, duration, ease, spring } = motionTokens
const enter: Transition = { duration: duration.standard, ease: [...ease.enter] }
const exitFast: Transition = { duration: duration.fast, ease: [...ease.standard] }
const instant: Transition = { duration: 0 }
const textIn: TargetAndTransition = { opacity: 0, y: '0.3em', filter: `blur(${blur.soft}px)` }
const textOut: TargetAndTransition = {
	opacity: 0,
	y: '-0.3em',
	filter: `blur(${blur.subtle}px)`,
	transition: exitFast,
}
const iconIn: TargetAndTransition = { opacity: 0, scale: 0.6, filter: `blur(${blur.subtle}px)` }
const shown: TargetAndTransition = { opacity: 1, y: '0em', scale: 1, filter: 'blur(0px)' }
const fadeOut: TargetAndTransition = { opacity: 0, transition: { duration: duration.instant } }
// Arc's 240ms and 80ms literal delays at 0.7x.
const BAR_FOLD_DELAY = 0.168
const CHECK_DRAW_DELAY = 0.056

export function FileUpload({
	accept,
	disabled = false,
	label = 'Upload files',
	description = 'Drop files here or browse from your device.',
	multiple = true,
	maxSize,
	value,
	onChange,
	onUpload,
}: FileUploadProps) {
	const inputId = useId()
	const reduce = useReducedMotion()
	const inputRef = useRef<HTMLInputElement>(null)
	const dropzoneRef = useRef<HTMLDivElement>(null)
	const [internalFiles, setInternalFiles] = useState<FileUploadItem[]>([])
	const [dragging, setDragging] = useState(false)
	const [status, setStatus] = useState('')
	const [uploads, setUploads] = useState<Record<string, Upload>>({})
	const dragDepth = useRef(0)
	const nextId = useRef(0)
	const controllers = useRef(new Map<string, AbortController>())
	const removeRefs = useRef(new Map<string, HTMLButtonElement>())
	const files = value ?? internalFiles

	useEffect(() => {
		const active = controllers.current
		return () => active.forEach(controller => controller.abort())
	}, [])

	function update(next: FileUploadItem[]) {
		if (value === undefined) setInternalFiles(next)
		onChange?.(next)
	}

	function startUpload(item: FileUploadItem) {
		if (!onUpload) return
		controllers.current.get(item.id)?.abort()
		const controller = new AbortController()
		controllers.current.set(item.id, controller)
		const set = (next: (current?: Upload) => Upload) =>
			setUploads(current => ({ ...current, [item.id]: next(current[item.id]) }))
		set(() => ({ status: 'uploading', progress: 0 }))
		onUpload(item.file, {
			signal: controller.signal,
			onProgress: percent => {
				if (controller.signal.aborted) return
				set(current => ({
					status: 'uploading',
					progress: Math.min(Math.max(percent, current?.progress ?? 0), 100),
				}))
			},
		})
			.then(
				() => {
					if (controller.signal.aborted) return
					set(() => ({ status: 'done', progress: 100 }))
					setStatus(`${item.file.name} uploaded.`)
				},
				() => {
					if (controller.signal.aborted) return
					set(current => ({ status: 'failed', progress: current?.progress ?? 0 }))
					setStatus(`${item.file.name} could not be uploaded.`)
				},
			)
			.finally(() => {
				if (controllers.current.get(item.id) === controller) controllers.current.delete(item.id)
			})
	}

	function addFiles(fileList: FileList) {
		const incoming = Array.from(fileList).slice(0, multiple ? undefined : 1)
		const acceptedTypes = (accept ?? '')
			.split(',')
			.map(type => type.trim().toLowerCase())
			.filter(Boolean)
		const added = incoming.map(file => ({
			id: `${file.name}-${file.lastModified}-${nextId.current++}`,
			file,
			error: !matchesAccept(file, acceptedTypes)
				? 'This file type is not accepted.'
				: maxSize && file.size > maxSize
					? `File is larger than ${formatSize(maxSize)}.`
					: undefined,
		}))
		if (!multiple) controllers.current.forEach(controller => controller.abort())
		update(multiple ? [...files, ...added] : added)
		const invalidCount = added.filter(item => item.error).length
		const validCount = added.length - invalidCount
		const addedMessage = `${validCount} file${validCount === 1 ? '' : 's'} added.`
		const attention = `${invalidCount} file${invalidCount === 1 ? ' needs' : 's need'} attention.`
		if (!invalidCount) setStatus(addedMessage)
		else setStatus(validCount ? `${addedMessage} ${attention}` : attention)
		added.filter(item => !item.error).forEach(startUpload)
	}

	function removeFile(item: FileUploadItem) {
		controllers.current.get(item.id)?.abort()
		controllers.current.delete(item.id)
		// Focus stays in the list: the next row's remove button, else the previous one, else the dropzone.
		const index = files.findIndex(file => file.id === item.id)
		const neighbor = files[index + 1] ?? files[index - 1]
		update(files.filter(file => file.id !== item.id))
		setStatus(`${item.file.name} removed.`)
		requestAnimationFrame(() => (neighbor ? removeRefs.current.get(neighbor.id) : dropzoneRef.current)?.focus())
	}

	function handleInput(event: ChangeEvent<HTMLInputElement>) {
		if (event.target.files) addFiles(event.target.files)
		event.target.value = ''
	}

	function handleDrop(event: DragEvent<HTMLDivElement>) {
		event.preventDefault()
		dragDepth.current = 0
		setDragging(false)
		if (!disabled && event.dataTransfer.files.length) addFiles(event.dataTransfer.files)
	}

	function handleDragEnter(event: DragEvent<HTMLDivElement>) {
		event.preventDefault()
		if (disabled) return
		dragDepth.current += 1
		setDragging(true)
	}

	function handleDragLeave(event: DragEvent<HTMLDivElement>) {
		event.preventDefault()
		dragDepth.current = Math.max(0, dragDepth.current - 1)
		if (dragDepth.current === 0) setDragging(false)
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (disabled) return
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault()
			inputRef.current?.click()
		}
	}

	const height: Transition = reduce ? instant : { height: spring.smooth, opacity: enter }
	const swap: MotionProps = {
		initial: reduce ? { opacity: 0 } : textIn,
		animate: shown,
		exit: reduce ? fadeOut : textOut,
		transition: reduce ? instant : enter,
	}

	return (
		<div className='grid w-full min-w-0 text-foreground'>
			<input
				ref={inputRef}
				id={inputId}
				className='sr-only'
				type='file'
				accept={accept}
				multiple={multiple}
				disabled={disabled}
				onChange={handleInput}
			/>
			{/* Press feedback is color only, never a scale: the target spans the full width. */}
			<div
				ref={dropzoneRef}
				role='button'
				tabIndex={disabled ? -1 : 0}
				aria-disabled={disabled}
				aria-describedby={`${inputId}-description`}
				data-dragging={dragging || undefined}
				className='group flex min-h-[92px] items-center gap-3 rounded-panel border border-dashed border-border-strong bg-surface p-4 transition-[border-color,background-color] duration-170 ease-standard not-aria-disabled:hover:border-accent not-aria-disabled:hover:bg-accent-subtle not-aria-disabled:active:border-accent not-aria-disabled:active:bg-accent-subtle aria-disabled:cursor-not-allowed aria-disabled:opacity-52 data-dragging:border-accent data-dragging:bg-accent-subtle'
				onClick={() => !disabled && inputRef.current?.click()}
				onKeyDown={handleKeyDown}
				onDragEnter={handleDragEnter}
				onDragOver={event => event.preventDefault()}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<span className='grid size-6 flex-none place-items-center text-accent-strong transition-transform duration-400 ease-spring motion-safe:group-data-dragging:-translate-y-0.75'>
					<IconCloudUpload size={20} stroke={1.75} aria-hidden />
				</span>
				<span className='grid min-w-0 flex-1 gap-0.75'>
					<strong className='relative block min-w-0 text-sm font-medium'>
						<AnimatePresence mode='popLayout' initial={false}>
							<Swap key={dragging ? 'drop' : 'idle'} className='block' {...swap}>
								{dragging ? `Drop to add ${multiple ? 'files' : 'a file'}` : label}
							</Swap>
						</AnimatePresence>
					</strong>
					<span id={`${inputId}-description`} className='text-xs wrap-anywhere text-muted'>
						{description}
					</span>
				</span>
				<span className='flex-none text-xs font-medium text-accent-strong'>Browse</span>
			</div>
			{/* The live region stays mounted; its frame opens on the first message and each new message rises in. */}
			<motion.div
				className='overflow-hidden'
				initial={false}
				animate={{ height: status ? 'auto' : 0 }}
				transition={height}
			>
				<p className='relative m-0 min-h-4 pt-2 text-xs text-muted' aria-live='polite' aria-atomic='true'>
					<AnimatePresence mode='popLayout' initial={false}>
						{status ? (
							<Swap key={status} className='block' {...swap}>
								{status}
							</Swap>
						) : null}
					</AnimatePresence>
				</p>
			</motion.div>
			<motion.ul
				className='grid'
				aria-label='Selected files'
				aria-hidden={files.length === 0 ? true : undefined}
				initial={false}
				animate={{ paddingTop: files.length ? 6 : 0 }}
				transition={reduce ? instant : spring.smooth}
			>
				<AnimatePresence initial={false}>
					{files.map(item => (
						// The gap lives inside the clipped row, so a collapsing row reaches zero height.
						<motion.li
							key={item.id}
							className='overflow-hidden'
							initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
							animate={{ height: 'auto', opacity: 1 }}
							exit={
								reduce
									? fadeOut
									: {
											height: 0,
											opacity: 0,
											transition: { height: spring.smooth, opacity: exitFast },
										}
							}
							transition={height}
						>
							<FileRow
								item={item}
								upload={uploads[item.id]}
								reduce={reduce}
								swap={swap}
								onRemove={() => removeFile(item)}
								onRetry={() => startUpload(item)}
								removeRef={node => {
									if (node) removeRefs.current.set(item.id, node)
									else removeRefs.current.delete(item.id)
								}}
							/>
						</motion.li>
					))}
				</AnimatePresence>
			</motion.ul>
		</div>
	)
}

function FileRow({
	item,
	upload,
	reduce,
	swap,
	onRemove,
	onRetry,
	removeRef,
}: {
	item: FileUploadItem
	upload?: Upload
	reduce: boolean | null
	swap: MotionProps
	onRemove: () => void
	onRetry: () => void
	removeRef: (node: HTMLButtonElement | null) => void
}) {
	const status = upload?.status
	// A finished upload keeps its bar until the spring reaches the end, so 100% shows before the label turns to Uploaded.
	const [filled, setFilled] = useState(status !== 'uploading')
	const [seen, setSeen] = useState(status)
	if (seen !== status) {
		setSeen(status)
		if (status === 'uploading') setFilled(false)
	}
	const shownStatus = status === 'done' && !filled && !reduce ? 'uploading' : status
	const phase = item.error ? 'invalid' : (shownStatus ?? 'ready')
	// One spring drives the bar and the counted percentage, so both always agree.
	const progress = useMotionValue(upload?.progress ?? 0)
	// The fill slides in from the left instead of scaling, so its rounded end keeps its shape.
	const x = useTransform(progress, latest => `${clampPercent(latest) - 100}%`)
	const percent = useTransform(progress, latest => `${Math.round(clampPercent(latest))}%`)
	const target = status === 'done' ? 100 : (upload?.progress ?? 0)

	useEffect(() => {
		// Every upload starts from an empty bar, even a retry that failed halfway.
		if (reduce || (status === 'uploading' && target === 0)) {
			progress.jump(target)
			return
		}
		const controls = animate(progress, target, {
			...spring.smooth,
			onComplete: status === 'done' ? () => setFilled(true) : undefined,
		})
		return () => controls.stop()
	}, [status, target, progress, reduce])

	// The label turns once the count reads 100%, without waiting out the spring's last fraction of a pixel.
	useMotionValueEvent(progress, 'change', latest => {
		if (status === 'done' && latest >= 99.5) setFilled(true)
	})

	return (
		<div className='mt-1.5 flex min-w-0 items-center gap-3 rounded-control border border-border-subtle bg-surface-muted py-2.5 pr-2.5 pl-3'>
			<span className='grid size-6 flex-none place-items-center text-secondary'>
				<FileTypeIcon file={item.file} />
			</span>
			<span className='grid min-w-0 flex-1 gap-0.5'>
				<strong title={item.file.name} className='truncate text-sm font-medium'>
					{item.file.name}
				</strong>
				<span className='flex min-w-0 text-xs whitespace-nowrap text-muted tabular-nums'>
					{formatSize(item.file.size)}
					{shownStatus ? (
						<>
							<span className='px-1.25' aria-hidden='true'>
								·
							</span>
							<span className='relative inline-block'>
								<AnimatePresence mode='popLayout' initial={false}>
									<Swap
										key={shownStatus}
										className={cn('block', shownStatus === 'failed' && 'text-danger')}
										{...swap}
									>
										{shownStatus === 'uploading' ? (
											<>
												Uploading{' '}
												<motion.span className='inline-block min-w-[4ch]'>
													{percent}
												</motion.span>
											</>
										) : shownStatus === 'done' ? (
											'Uploaded'
										) : (
											'Upload failed'
										)}
									</Swap>
								</AnimatePresence>
							</span>
						</>
					) : null}
				</span>
				{item.error && <span className='text-xs text-danger'>{item.error}</span>}
				{/* The bar fills on a spring, then folds away once the file lands. */}
				<AnimatePresence initial={false}>
					{shownStatus === 'uploading' && (
						<motion.span
							key='bar'
							className='block'
							initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
							animate={{ height: 'auto', opacity: 1 }}
							exit={
								reduce
									? fadeOut
									: {
											height: 0,
											opacity: 0,
											transition: {
												height: { ...spring.smooth, delay: BAR_FOLD_DELAY },
												opacity: { ...exitFast, delay: BAR_FOLD_DELAY },
											},
										}
							}
							transition={reduce ? instant : { height: spring.smooth, opacity: enter }}
						>
							<span className='mt-1.25 mb-px block h-0.75 overflow-hidden rounded-full bg-border'>
								<motion.span className='block size-full rounded-[inherit] bg-accent' style={{ x }} />
							</span>
						</motion.span>
					)}
				</AnimatePresence>
			</span>
			<span className='relative grid size-6.5 flex-none place-items-center'>
				<AnimatePresence mode='popLayout' initial={false}>
					{(phase === 'ready' || phase === 'done') && (
						<motion.span
							key='ready'
							className='grid size-5.5 place-items-center text-success'
							initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={fadeOut}
							transition={reduce ? instant : spring.snappy}
						>
							<svg
								width={14}
								height={14}
								viewBox='0 0 24 24'
								fill='none'
								stroke='currentColor'
								strokeWidth={2}
								strokeLinecap='round'
								strokeLinejoin='round'
								aria-hidden='true'
							>
								<motion.path
									d='M4 12.5l5 5L20 6.5'
									initial={reduce ? false : { pathLength: 0 }}
									animate={{ pathLength: 1 }}
									transition={{ ...enter, delay: CHECK_DRAW_DELAY }}
								/>
							</svg>
							<span className='sr-only'>{phase === 'done' ? 'Uploaded' : 'Ready'}</span>
						</motion.span>
					)}
					{/* The wrapper carries the entrance, so the button's own press scale never competes with it. */}
					{phase === 'failed' && (
						<motion.span
							key='retry'
							className='grid place-items-center'
							initial={reduce ? { opacity: 0 } : iconIn}
							animate={shown}
							exit={reduce ? fadeOut : { ...iconIn, transition: exitFast }}
							transition={reduce ? instant : spring.snappy}
						>
							<button
								type='button'
								className='grid size-6.5 flex-none press place-items-center rounded-full text-secondary hover:bg-surface-muted hover:text-foreground'
								aria-label={`Retry ${item.file.name}`}
								onClick={onRetry}
							>
								<IconRotateClockwise size={14} stroke={1.75} aria-hidden />
							</button>
						</motion.span>
					)}
				</AnimatePresence>
			</span>
			<button
				ref={removeRef}
				type='button'
				className='grid size-6.5 flex-none press place-items-center rounded-full text-muted hover:bg-surface-muted hover:text-foreground'
				aria-label={`Remove ${item.file.name}`}
				onClick={onRemove}
			>
				<IconX size={16} stroke={1.75} aria-hidden />
			</button>
		</div>
	)
}

// Outgoing copies are hidden from assistive tech while they fade, so live text reads only the current message.
function Swap(props: HTMLMotionProps<'span'>) {
	const present = useIsPresent()
	return <motion.span {...props} aria-hidden={present ? props['aria-hidden'] : true} />
}

function FileTypeIcon({ file }: { file: File }) {
	const props = { size: 16, stroke: 1.75, 'aria-hidden': true } as const
	if (file.type.startsWith('image/')) return <IconPhoto {...props} />
	if (file.type.startsWith('text/')) return <IconFileText {...props} />
	if (file.type.includes('zip') || file.name.endsWith('.gz')) return <IconFileZip {...props} />
	return <IconFile {...props} />
}

function matchesAccept(file: File, acceptedTypes: string[]) {
	if (acceptedTypes.length === 0) return true
	return acceptedTypes.some(type => {
		if (type.startsWith('.')) return file.name.toLowerCase().endsWith(type)
		if (type.endsWith('/*')) return file.type.startsWith(type.slice(0, -1))
		return file.type === type
	})
}

function formatSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	const mb = bytes / (1024 * 1024)
	return `${mb >= 10 ? Math.round(mb) : Number(mb.toFixed(1))} MB`
}

function clampPercent(value: number) {
	return Math.min(Math.max(value, 0), 100)
}
