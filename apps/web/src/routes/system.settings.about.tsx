import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { cn } from '@/utils/cn'
import { Button, Check, ErrorText, Section } from '../components/primitives'
import { api, updateActive, type UpdatePhase, type VersionSettings } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/system/settings/about')({ component: Version })

/**
 * The update timeline. `phase` values from the state file map onto a step;
 * the restart gap (manager down, fetch failing) renders as the restart step.
 */
const steps = [
	{ phase: 'backup', label: 'Backup', hint: 'platform state, kept for rollback' },
	{ phase: 'pulling', label: 'Pull images', hint: 'the panel stays up for this part' },
	{ phase: 'restarting', label: 'Restart', hint: 'panel unreachable for ~15 s' },
	{ phase: 'done', label: 'Health check', hint: 'rolls back on failure' },
] as const

/** A finished update stays in the state file forever; only show the outcome banner this long. */
const RESULT_TTL_SECONDS = 3600

function Version() {
	const queryClient = useQueryClient()
	const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })
	const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000 })
	const state = useQuery({
		queryKey: ['update-state'],
		queryFn: api.updateState,
		retry: false,
		// Poll tightly while an update moves or the manager is down (the restart
		// gap manifests as fetch errors); otherwise a slow heartbeat is plenty.
		refetchInterval: query => (updateActive(query.state.data?.phase) || query.state.error ? 2000 : 15_000),
	})

	// While the manager restarts the status fetch fails; the last known state
	// said the update was moving, so render that as the restart step.
	const lastPhase = state.data?.phase ?? 'idle'
	const phase: UpdatePhase = updateActive(lastPhase) && state.isError ? 'restarting' : lastPhase
	const active = updateActive(phase)
	const resultAge = state.data ? Date.now() / 1000 - state.data.at : Number.POSITIVE_INFINITY
	const showResult = (phase === 'done' || phase === 'rolled-back') && resultAge < RESULT_TTL_SECONDS

	// The moment an update lands, installed version and health are stale.
	useEffect(() => {
		if (phase === 'done' || phase === 'rolled-back') {
			void queryClient.invalidateQueries({ queryKey: ['version'] })
			void queryClient.invalidateQueries({ queryKey: ['health'] })
		}
	}, [phase, queryClient])

	const setSettings = useMutation({
		mutationFn: api.setVersionSettings,
		onSuccess: data => queryClient.setQueryData(['version'], data),
	})

	// The manager caches the release lookup for two minutes and the panel polls
	// once a minute, so a fresh release can take that long to appear on its own.
	const check = useMutation({
		mutationFn: api.checkVersion,
		onSuccess: data => queryClient.setQueryData(['version'], data),
	})

	const update = useMutation({
		mutationFn: () => api.update(version.data?.latest),
		// The state file already says "backup" by the time the POST returns, but
		// seed the cache so the timeline appears without waiting for a poll.
		onSuccess: () => {
			queryClient.setQueryData(['update-state'], {
				phase: 'backup',
				target: version.data?.latest ?? '',
				previous: version.data?.current ?? '',
				error: '',
				at: Date.now() / 1000,
			})
		},
	})

	// The endpoint takes the whole preference set, so a toggle carries the
	// other one along.
	const save = (patch: Partial<VersionSettings>) => {
		if (!version.data) return
		const { beta, cleanup_old_images } = version.data
		setSettings.mutate({ beta, cleanup_old_images, ...patch })
	}

	const healthy = health.data?.status === 'healthy'
	const checks = Object.entries(health.data?.checks ?? {}).toSorted(([a], [b]) => a.localeCompare(b))
	const canUpdate = (version.data?.update_available ?? false) && healthy && !active && !update.isPending
	const busy = active || update.isPending

	return (
		<Section title='Version' description='a backup is taken before the swap and rolled back if health fails'>
			<div className='flex max-w-2xl flex-col gap-5'>
				<div className='flex items-center gap-10'>
					<dl className='flex gap-10'>
						<div>
							<dt className='text-label tracking-wide text-muted-foreground uppercase'>Installed</dt>
							<dd className='font-mono text-title'>{version.data?.current ?? '-'}</dd>
						</div>
						<div>
							<dt className='text-label tracking-wide text-muted-foreground uppercase'>Latest</dt>
							<dd
								className={`font-mono text-title ${version.data?.update_available ? 'text-emerald-400' : ''}`}
							>
								{version.data?.latest || 'unknown'}
							</dd>
							<div className='flex items-baseline gap-2 text-label text-muted-foreground'>
								{version.data?.release_url ? (
									<a
										href={version.data.release_url}
										target='_blank'
										rel='noopener noreferrer'
										className='hover:text-foreground hover:underline'
									>
										release notes
									</a>
								) : null}
								<span>
									{check.isPending ? 'checking…' : `checked ${since(version.data?.checked_at)}`}
								</span>
							</div>
						</div>
					</dl>
					<div className='flex items-center gap-2'>
						<Button onClick={() => check.mutate()} disabled={check.isPending || busy}>
							Check for updates
						</Button>
						<Button variant='primary' onClick={() => update.mutate()} disabled={!canUpdate}>
							{busy && 'Updating…'}
							{!busy &&
								(version.data?.update_available ? `Update to ${version.data.latest}` : 'Up to date')}
						</Button>
					</div>
				</div>

				{busy ? (
					<UpdateTimeline phase={phase} target={state.data?.target || version.data?.latest || ''} />
				) : (
					<div className='flex flex-col gap-1.5'>
						<span className='text-label tracking-wide text-muted-foreground uppercase'>Preflight</span>
						{checks.length === 0 ? (
							<span className='text-body text-muted-foreground'>
								{health.isError ? 'health check unreachable' : 'checking…'}
							</span>
						) : (
							checks.map(([name, result]) => (
								<div key={name} className='flex items-baseline gap-2 text-body'>
									<span
										className={cn(
											'size-1.5 shrink-0 self-center rounded-full',
											result === 'ok' ? 'bg-emerald-400' : 'bg-red-400',
										)}
									/>
									<span className='w-20 text-muted-foreground'>{name}</span>
									<span className={result === 'ok' ? 'text-muted-foreground' : 'text-red-400'}>
										{result}
									</span>
								</div>
							))
						)}
						{healthy || health.isLoading ? null : (
							<p className='text-body text-red-400'>
								Updates are blocked until the failing checks recover; the server refuses them too.
							</p>
						)}
					</div>
				)}

				{showResult && state.data && phase === 'done' ? (
					<p className='text-body text-emerald-400'>Updated to {state.data.target}.</p>
				) : null}
				{showResult && state.data && phase === 'rolled-back' ? (
					<div className='flex flex-col gap-2'>
						<p className='text-body text-red-400'>
							Update to {state.data.target} rolled back
							{state.data.error ? `: ${state.data.error}` : ''}. Still on {state.data.previous}.
						</p>
						{state.data.log ? (
							<pre className='overflow-x-auto rounded-xl border px-3 py-2 font-mono text-label text-muted-foreground'>
								{state.data.log}
							</pre>
						) : null}
					</div>
				) : null}

				<div className='flex flex-col gap-4'>
					<Check
						label='Include beta releases'
						checked={version.data?.beta ?? false}
						disabled={setSettings.isPending || version.isLoading || busy}
						onChange={beta => save({ beta })}
					/>
					<Check
						label='Remove previous version images after a successful update'
						checked={version.data?.cleanup_old_images ?? false}
						disabled={setSettings.isPending || version.isLoading || busy}
						onChange={cleanup_old_images => save({ cleanup_old_images })}
					/>
				</div>
				<ErrorText error={update.error ?? setSettings.error ?? check.error} />
			</div>
		</Section>
	)
}

function UpdateTimeline({ phase, target }: { phase: UpdatePhase; target: string }) {
	// done means every step finished; otherwise everything before the current
	// phase's step is finished and everything after is pending.
	const currentIndex = phase === 'done' ? steps.length : steps.findIndex(step => step.phase === phase)

	return (
		<div className='flex flex-col'>
			<span className='pb-2 font-mono text-body'>
				{phase === 'done' ? `updated to ${target}` : `updating to ${target}`}
			</span>
			{steps.map((step, index) => {
				const done = index < currentIndex
				const now = index === currentIndex
				return (
					<div
						key={step.phase}
						className={cn(
							'relative border-l pb-3.5 pl-4 last:border-l-transparent last:pb-0',
							done && 'border-l-emerald-400/40',
						)}
					>
						<span
							className={cn(
								'absolute top-1 -left-1 size-2 rounded-full border-2 border-background',
								done && 'bg-emerald-400',
								now && 'bg-foreground',
								!(done || now) && 'bg-muted',
							)}
						/>
						<div className={cn('text-body font-medium', !(done || now) && 'text-muted-foreground')}>
							{step.label}
						</div>
						{now ? <div className='text-label text-muted-foreground'>{step.hint}</div> : null}
					</div>
				)
			})}
		</div>
	)
}
