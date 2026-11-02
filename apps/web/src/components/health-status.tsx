import { type ReactNode, useId } from 'react'
import { cn } from 'cn'
import { motion, useReducedMotion } from 'motion/react'
import type { HealthReport } from '../lib/api'
import { motionTokens } from '../lib/motion'

const CHECK_LINES = [
	[6.1, 10.3, 8.8, 13],
	[8.8, 13, 14, 7.4],
]
const ALERT_LINES = [
	[10, 14.1, 10, 14.1],
	[10, 5.8, 10, 10.9],
]

/** Arc's uptime-status header and service rows over `/api/health`; the manager keeps no history, so no day strip. */
export function HealthStatus({
	report,
	updatedAt,
	actions,
}: {
	report?: HealthReport
	updatedAt: ReactNode
	actions?: ReactNode
}) {
	const headingId = useId()
	const checks = Object.entries(report?.checks ?? {})
	const failing = checks.filter(([, result]) => result !== 'ok').length
	const degraded = report !== undefined && report.status !== 'healthy'

	return (
		<section
			aria-labelledby={headingId}
			className='@container mb-8 grid min-w-0 rounded-surface border bg-surface text-sm'
		>
			<header
				data-state={degraded ? 'degraded' : 'operational'}
				className='grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-t-[inherit] px-4 py-3 transition-colors [--status:var(--success)] data-[state=degraded]:bg-[color-mix(in_oklab,var(--danger)_6%,var(--surface))] data-[state=degraded]:[--status:var(--danger)]'
			>
				<StatusGlyph degraded={degraded} />
				<div className='grid min-w-0 gap-0.5'>
					<h2 id={headingId} className='m-0 text-base font-medium'>
						{report === undefined
							? 'Checking the platform'
							: degraded
								? `${failing} of ${checks.length} checks failing`
								: 'All systems operational'}
					</h2>
					<p className='m-0 truncate text-sm text-secondary'>{updatedAt}</p>
				</div>
				{actions}
			</header>
			<ul className='border-t'>
				{checks.map(([name, result]) => (
					<li
						key={name}
						className='flex min-w-0 items-center gap-3 px-4 py-2.5 not-first:border-t not-first:border-border-subtle'
					>
						<StatusMark ok={result === 'ok'} />
						<span className='font-mono text-xs'>{name}</span>
						<span
							className={cn('ml-auto truncate text-xs', result === 'ok' ? 'text-muted' : 'text-danger')}
						>
							{result === 'ok' ? 'Operational' : result}
						</span>
					</li>
				))}
			</ul>
		</section>
	)
}

function StatusMark({ ok }: { ok: boolean }) {
	const height = ok ? 14 : 5
	return (
		<svg width='8' height='14' viewBox='0 0 8 14' aria-hidden='true' className='flex-none'>
			<rect
				x='0'
				y={14 - height}
				width='8'
				height={height}
				rx='1.5'
				className={ok ? 'fill-[color-mix(in_oklab,var(--success)_62%,var(--surface))]' : 'fill-danger'}
			/>
		</svg>
	)
}

function StatusGlyph({ degraded }: { degraded: boolean }) {
	const reduce = useReducedMotion()
	return (
		<svg viewBox='0 0 20 20' aria-hidden='true' className='block size-7 flex-none overflow-visible text-(--status)'>
			<circle cx='10' cy='10' r='10' className='fill-[color-mix(in_oklab,var(--status)_14%,var(--surface))]' />
			{(degraded ? ALERT_LINES : CHECK_LINES).map(([x1, y1, x2, y2], stroke) => (
				<motion.line
					key={stroke}
					className='fill-none stroke-current stroke-[1.3] [stroke-linecap:round]'
					initial={false}
					animate={{ x1, y1, x2, y2 }}
					transition={reduce ? { duration: 0 } : { ...motionTokens.spring.morph, delay: 0.028 * stroke }}
				/>
			))}
		</svg>
	)
}
