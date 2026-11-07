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
const PENDING_LINES = [
	[6.5, 10, 10, 10],
	[10, 10, 13.5, 10],
]
const LOOKS = {
	checking: { lines: PENDING_LINES, tone: 'muted' },
	unreachable: { lines: ALERT_LINES, tone: 'danger' },
	degraded: { lines: ALERT_LINES, tone: 'danger' },
	operational: { lines: CHECK_LINES, tone: 'success' },
}

/** Arc's uptime-status header and service rows over `/api/health`; the manager keeps no history, so no day strip. */
export function HealthStatus({
	report,
	error,
	updatedAt,
	actions,
}: {
	report?: HealthReport
	error: Error | null
	updatedAt: ReactNode
	actions?: ReactNode
}) {
	const headingId = useId()
	// A failed read keeps the last report in the cache; its checks would claim a health nobody just measured.
	const checks = error ? [] : Object.entries(report?.checks ?? {})
	const failing = checks.filter(([, result]) => result !== 'ok').length
	const state = healthState(report, error, failing)
	const heading = {
		checking: 'Checking the platform',
		unreachable: 'Could not reach the manager',
		degraded: checks.length > 0 ? `${failing} of ${checks.length} checks failing` : 'The manager reports unhealthy',
		operational: 'All systems operational',
	}[state]

	return (
		<section aria-labelledby={headingId} className='mb-8 grid min-w-0 rounded-surface border bg-surface text-sm'>
			<header
				data-tone={LOOKS[state].tone}
				className='grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-t-[inherit] px-4 py-3 transition-colors [--status:var(--success)] last:rounded-b-[inherit] data-[tone=danger]:bg-[color-mix(in_oklab,var(--danger)_6%,var(--surface))] data-[tone=danger]:[--status:var(--danger)] data-[tone=muted]:[--status:var(--text-muted)]'
			>
				<StatusGlyph lines={LOOKS[state].lines} />
				<span role='status' className='sr-only'>
					{heading}
				</span>
				<div className='grid min-w-0 gap-0.5'>
					<h2 id={headingId} className='m-0 text-base font-medium'>
						{heading}
					</h2>
					<p className={cn('m-0 text-sm text-secondary', error ? 'wrap-anywhere' : 'truncate')}>
						{updatedAt}
					</p>
				</div>
				{actions}
			</header>
			{checks.length > 0 ? (
				<ul className='border-t'>
					{checks.map(([name, result]) => (
						<li
							key={name}
							className='flex min-w-0 items-center gap-3 px-4 py-2.5 not-first:border-t not-first:border-border-subtle'
						>
							<StatusMark ok={result === 'ok'} />
							<span className='font-mono text-xs'>{name}</span>
							<span
								className={cn(
									'ml-auto min-w-0 text-right text-xs wrap-anywhere',
									result === 'ok' ? 'text-muted' : 'text-danger',
								)}
							>
								{result === 'ok' ? 'Operational' : result}
							</span>
						</li>
					))}
				</ul>
			) : null}
		</section>
	)
}

function healthState(report: HealthReport | undefined, error: Error | null, failing: number) {
	if (error) return 'unreachable'
	if (!report) return 'checking'
	// The manager stays `healthy` with a failing proxy, so the checks decide, not the status.
	return report.status === 'healthy' && failing === 0 ? 'operational' : 'degraded'
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

function StatusGlyph({ lines }: { lines: number[][] }) {
	const reduce = useReducedMotion()
	return (
		<svg viewBox='0 0 20 20' aria-hidden='true' className='block size-7 flex-none overflow-visible text-(--status)'>
			<circle cx='10' cy='10' r='10' className='fill-[color-mix(in_oklab,var(--status)_14%,var(--surface))]' />
			{lines.map(([x1, y1, x2, y2], stroke) => (
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
