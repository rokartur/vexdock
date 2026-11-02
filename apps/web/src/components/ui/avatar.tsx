import { type HTMLAttributes, useLayoutEffect, useRef, useState } from 'react'
import { cn } from 'cn'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'
type AvatarStatus = 'online' | 'offline'

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
	name: string
	src?: string
	size?: AvatarSize
	status?: AvatarStatus
}

const sizeClass: Record<AvatarSize, string> = {
	sm: 'size-7 text-[10px]/[1.4]',
	md: 'size-9',
	lg: 'size-12 text-sm',
	xl: 'size-22 text-xl',
}

const statusSizeClass: Record<AvatarSize, string> = {
	sm: 'size-2 border-[1.5px]',
	md: 'size-2.5',
	lg: 'size-3',
	xl: 'size-3.5 right-1 bottom-1',
}

const statusColorClass: Record<AvatarStatus, string> = {
	online: 'bg-success',
	offline: 'bg-muted',
}

export function Avatar({ name, src, size = 'md', status, className, ...props }: AvatarProps) {
	const initials = name
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.map(part => part[0]?.toUpperCase())
		.join('')
	const reduceMotion = !!useReducedMotion()
	const image = useRef<HTMLImageElement>(null)
	const [failedSrc, setFailedSrc] = useState<string>()
	// A photo that is already decoded shows at once. One that is still loading waits, then fades in from a soft blur.
	// One that failed before hydration never fired onError, so it falls back here.
	useLayoutEffect(() => {
		const node = image.current
		if (!node) return
		if (node.complete) {
			node.decode().catch(() => setFailedSrc(src))
		} else {
			node.dataset.loading = ''
		}
	}, [src])
	const showImage = src && failedSrc !== src

	return (
		<span
			{...props}
			className={cn(
				'relative inline-grid flex-none place-items-center overflow-visible rounded-full border bg-surface-muted text-xs font-medium text-foreground',
				sizeClass[size],
				className,
			)}
			role='img'
			aria-label={`${name}${status ? `, ${status}` : ''}`}
		>
			{showImage ? (
				<img
					key={src}
					ref={image}
					src={src}
					alt=''
					loading='lazy'
					decoding='async'
					onLoad={event => {
						delete event.currentTarget.dataset.loading
					}}
					onError={() => setFailedSrc(src)}
					className='pointer-events-none absolute inset-0 size-full rounded-[inherit] object-cover transition-[opacity,filter] duration-170 ease-enter data-loading:opacity-0 data-loading:blur-[4px] data-loading:transition-none motion-reduce:data-loading:blur-none'
				/>
			) : (
				<span
					className={cn(src && 'transition-opacity duration-170 ease-enter starting:opacity-0')}
					aria-hidden='true'
				>
					{initials}
				</span>
			)}
			<AnimatePresence initial={false}>
				{status && (
					<motion.i
						key={status}
						className={cn(
							'absolute right-0 bottom-0 z-2 size-2.5 rounded-full border-2 border-surface shadow-[0_0_0_1px_color-mix(in_oklab,var(--border)_70%,transparent)]',
							statusSizeClass[size],
							statusColorClass[status],
						)}
						aria-hidden='true'
						initial={{ opacity: 0, scale: 0.6 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={{
							opacity: 0,
							scale: 0.6,
							transition: { duration: reduceMotion ? 0 : motionTokens.duration.fast },
						}}
						transition={reduceMotion ? { duration: 0 } : motionTokens.spring.snappy}
					/>
				)}
			</AnimatePresence>
		</span>
	)
}
