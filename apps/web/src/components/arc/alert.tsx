'use client'

import type { HTMLAttributes, ReactNode } from 'react'
import { IconAlertTriangle, IconCheck, IconCircleX, IconInfoCircle } from '@tabler/icons-react'
import { AnimatePresence, motion, useReducedMotion, type MotionProps, type Transition } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'
import { exitFast, fadeOut, HeightFrame, iconIn, shown, Swap, textIn, textOut } from './swap'

const iconTones = {
	info: 'text-(--accent)',
	success: 'text-(--success)',
	warning: 'text-(--warning)',
	danger: 'text-(--danger)',
} as const

export type AlertTone = 'info' | 'success' | 'warning' | 'danger'
export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
	tone?: AlertTone
	title: string
	children?: ReactNode
}

const icons = { info: IconInfoCircle, success: IconCheck, warning: IconAlertTriangle, danger: IconCircleX }

export function Alert({ tone = 'info', title, children, className, ...props }: AlertProps) {
	const reduce = useReducedMotion()
	const Icon = icons[tone]
	const text = typeof children === 'string' || typeof children === 'number' ? String(children) : null
	const hasDetails = children !== undefined && children !== null && children !== false && children !== ''
	const enter: Transition = reduce
		? { duration: motionTokens.duration.instant }
		: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }
	const swap: MotionProps = {
		initial: reduce ? { opacity: 0 } : textIn,
		animate: shown,
		exit: reduce ? fadeOut : textOut,
		transition: enter,
	}
	return (
		<div
			{...props}
			className={cn(
				'flex items-start gap-(--space-3) rounded-(--radius-control) border border-border bg-(--surface) p-(--space-4) shadow-(--shadow-resting)',
				className,
			)}
			role={tone === 'danger' ? 'alert' : 'status'}
		>
			{/* A new tone morphs its icon in place. */}
			<span
				className={cn(
					'relative mt-px grid size-[18px] flex-none place-items-center [&_svg]:block',
					iconTones[tone],
				)}
			>
				<AnimatePresence mode='popLayout' initial={false}>
					<Swap
						key={tone}
						className='relative grid flex-none place-items-center'
						initial={reduce ? { opacity: 0 } : iconIn}
						animate={shown}
						exit={reduce ? fadeOut : { ...iconIn, transition: exitFast }}
						transition={reduce ? enter : motionTokens.spring.snappy}
					>
						<Icon size={18} stroke={1.75} aria-hidden='true' />
					</Swap>
				</AnimatePresence>
			</span>
			{/* The copy column follows its content height, so longer or shorter messages never snap the alert. */}
			<HeightFrame className='min-w-0 flex-1' reduce={reduce} morphKey={`${title}\n${hasDetails}\n${text ?? ''}`}>
				<strong className='relative block text-sm font-medium'>
					<AnimatePresence mode='popLayout' initial={false}>
						<Swap key={title} className='block' {...swap}>
							{title}
						</Swap>
					</AnimatePresence>
				</strong>
				{/* A div, not a p: details can be block content (a log in a <pre>). */}
				<AnimatePresence mode='popLayout' initial={false}>
					{hasDetails && (
						<motion.div
							key='details'
							className='relative mt-(--space-1) text-xs text-(--text-secondary)'
							{...swap}
						>
							{text === null ? (
								children
							) : (
								<AnimatePresence mode='popLayout' initial={false}>
									<Swap key={text} className='block' {...swap}>
										{text}
									</Swap>
								</AnimatePresence>
							)}
						</motion.div>
					)}
				</AnimatePresence>
			</HeightFrame>
		</div>
	)
}

export default Alert
