'use client'

import type { ReactNode } from 'react'
import { IconFolder } from '@tabler/icons-react'
import { AnimatePresence, useReducedMotion, type MotionProps, type Transition } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'
import { fadeOut, HeightFrame, iconIn, iconKey, shown, Swap, textIn, textOut, exitFast } from './swap'

export interface EmptyStateProps {
	title: string
	description?: string
	action?: ReactNode
	icon?: ReactNode
	className?: string
	/** Optional accessible label for the state region. */
	label?: string
}

export function EmptyState({ title, description, action, icon, className, label }: EmptyStateProps) {
	const reduce = useReducedMotion()
	const glyph = icon ?? <IconFolder size={24} stroke={1.5} />
	const enter: Transition = reduce
		? { duration: motionTokens.duration.instant }
		: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }
	const swap: MotionProps = {
		initial: reduce ? { opacity: 0 } : textIn,
		animate: shown,
		exit: reduce ? fadeOut : textOut,
		transition: enter,
	}
	// The result of an action morphs in place: the icon crossfades and the copy rises in while the old copy leaves.
	return (
		<section
			className={cn(
				'flex w-full flex-col items-center px-(--space-5) py-[clamp(var(--space-8),8vw,var(--space-12))] text-center',
				className,
			)}
			aria-label={label}
		>
			{/* The icon settles in once when the state first appears; later changes crossfade in place. */}
			<div
				className='relative grid size-(--space-12) place-items-center rounded-(--radius-panel) border border-border bg-(--surface-muted) text-(--text-secondary) transition-[opacity,scale] duration-(--duration-considered) ease-(--ease-enter) motion-reduce:transition-none starting:scale-92 starting:opacity-0'
				aria-hidden='true'
			>
				<AnimatePresence mode='popLayout' initial={false}>
					<Swap
						key={iconKey(glyph)}
						className='grid place-items-center'
						initial={reduce ? { opacity: 0 } : iconIn}
						animate={shown}
						exit={reduce ? fadeOut : { ...iconIn, transition: exitFast }}
						transition={reduce ? enter : motionTokens.spring.snappy}
					>
						{glyph}
					</Swap>
				</AnimatePresence>
			</div>
			<HeightFrame className='w-full max-w-full' reduce={reduce} morphKey={`${title}\n${description ?? ''}`}>
				<h3 className='relative mt-(--space-5) text-base/(--leading-body) font-medium text-foreground'>
					<AnimatePresence mode='popLayout' initial={false}>
						{/* Centered copy wraps into even lines, so a new description never leaves a single word hanging. */}
						<Swap key={title} className='block text-balance' {...swap}>
							{title}
						</Swap>
					</AnimatePresence>
				</h3>
				{description ? (
					<p className='relative mx-auto mt-(--space-2) max-w-72 text-sm/(--leading-body) text-(--text-secondary)'>
						<AnimatePresence mode='popLayout' initial={false}>
							<Swap key={description} className='block text-balance' {...swap}>
								{description}
							</Swap>
						</AnimatePresence>
					</p>
				) : null}
			</HeightFrame>
			{action && <div className='mt-(--space-5) flex flex-wrap justify-center gap-(--space-3)'>{action}</div>}
		</section>
	)
}

export default EmptyState
