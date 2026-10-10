'use client'

import { useEffect } from 'react'
import type { HTMLAttributes } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
	value?: number
	max?: number
}

export function Progress({ value = 0, max = 100, className, ...props }: ProgressProps) {
	const reduce = useReducedMotion()
	const safeMax = max > 0 ? max : 100
	const safeValue = Math.min(Math.max(value, 0), safeMax)
	const percentage = Math.round((safeValue / safeMax) * 100)
	const progress = useMotionValue(percentage)
	// The fill slides in from the left instead of scaling, so its rounded end keeps its shape at every value.
	const x = useTransform(progress, latest => `${Math.min(Math.max(latest, 0), 100) - 100}%`)
	useEffect(() => {
		if (reduce) {
			progress.jump(percentage)
			return
		}
		const controls = animate(progress, percentage, motionTokens.spring.smooth)
		return () => controls.stop()
	}, [percentage, progress, reduce])
	return (
		<div
			{...props}
			className={cn('group w-full', className)}
			data-complete={percentage >= 100 ? '' : undefined}
			role='progressbar'
			aria-label={props['aria-label'] ?? 'Progress'}
			aria-valuemin={0}
			aria-valuemax={safeMax}
			aria-valuenow={safeValue}
			aria-valuetext={`${percentage}%`}
		>
			<div className='h-1 overflow-hidden rounded-full bg-(--surface-muted)'>
				<motion.span
					className='block size-full rounded-[inherit] bg-(--accent) transition-colors duration-(--duration-standard) ease-(--ease-standard) group-data-complete:bg-(--success) group-data-complete:delay-200 motion-reduce:transition-none'
					style={{ x }}
				/>
			</div>
		</div>
	)
}
