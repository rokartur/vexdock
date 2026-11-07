import { useEffect } from 'react'
import { IconDownload, IconExternalLink, IconRefresh, IconTag } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { cn } from 'cn'
import { Alert } from '@/components/ui/alert'
import { CodeBlock } from '@/components/ui/code-block'
import { Skeleton } from '@/components/ui/skeleton'
import {
	Button,
	Cell,
	Cells,
	ErrorText,
	Field,
	FormSection,
	PendingReading,
	RelativeTime,
	Segmented,
	Status,
	Switch,
	Timeline,
	textLink,
} from '../components/primitives'
import { api, updateActive, type UpdatePhase, type VersionSettings, type VersionStatus } from '../lib/api'
import { healthQuery, preload, updateStateQuery, versionQuery } from '../lib/queries'

export const Route = createFileRoute('/system/settings/about')({
	loader: ({ context: { queryClient } }) =>
		Promise.all([
			preload(queryClient, versionQuery),
			preload(queryClient, healthQuery),
			preload(queryClient, updateStateQuery),
		]),
	component: Version,
})

/**
 * The update timeline. `phase` values from the state file map onto a step;
 * the restart gap (manager down, fetch failing) renders as the restart step.
 */
const steps = [
	{ phase: 'backup', label: 'Backup', hint: 'Platform state, kept for rollback' },
	{ phase: 'pulling', label: 'Pull images', hint: 'The panel stays up for this part' },
	{ phase: 'restarting', label: 'Restart', hint: 'Panel unreachable for ~15 s' },
	{ phase: 'done', label: 'Health check', hint: 'Rolls back on failure' },
] as const

/** A finished update stays in the state file forever; only show the outcome banner this long. */
const RESULT_TTL_SECONDS = 3600

const channels = [
	{ value: 'stable', label: 'Stable' },
	{ value: 'prerelease', label: 'Pre-release' },
] as const

function Version() {
	const queryClient = useQueryClient()
	// The shell already polls this key for the release check; this rides its cache.
	const version = useQuery(versionQuery)
	const health = useQuery(healthQuery)
	const state = useQuery({
		...updateStateQuery,
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
	// other one along. While a save is in flight its values are the ones shown.
	const prefs = setSettings.isPending ? setSettings.variables : version.data
	const save = (patch: Partial<VersionSettings>) => {
		if (!prefs) return
		const { beta, cleanup_old_images } = prefs
		setSettings.mutate({ beta, cleanup_old_images, ...patch })
	}

	const healthy = !health.isError && health.data?.status === 'healthy'
	const checks = Object.entries(health.data?.checks ?? {}).toSorted(([a], [b]) => a.localeCompare(b))
	const canUpdate = (version.data?.update_available ?? false) && healthy && !active && !update.isPending
	const busy = active || update.isPending

	return (
		<div className='max-w-3xl'>
			<ErrorText error={version.error} />
			<ErrorText error={update.error ?? setSettings.error ?? check.error} />
			<ErrorText
				error={version.data?.check_error && `Could not check for updates: ${version.data.check_error}`}
			/>
			{showResult && state.data && phase === 'done' ? (
				<Alert tone='success' title={`Updated to ${state.data.target}`} className='mb-4' />
			) : null}
			{showResult && state.data && phase === 'rolled-back' ? (
				<Alert
					tone='danger'
					title={`Update to ${state.data.target} rolled back, still on ${state.data.previous}${state.data.error ? `: ${state.data.error}` : ''}`}
					className='mb-4'
				>
					{state.data.log ? (
						<CodeBlock filename='Update log' language='log' code={state.data.log} maxLines={12} />
					) : null}
				</Alert>
			) : null}

			<FormSection
				title='Version'
				icon={IconTag}
				hint={
					<span className='flex items-center gap-3'>
						{check.isPending ? (
							'Checking…'
						) : version.data ? (
							<span>
								Checked <RelativeTime at={version.data.checked_at} />
							</span>
						) : null}
						{version.data?.release_url ? (
							<a
								href={version.data.release_url}
								target='_blank'
								rel='noopener noreferrer'
								className={cn(textLink, 'inline-flex items-center gap-1 hover:text-foreground')}
							>
								Release notes
								<IconExternalLink stroke={1.75} className='size-3' />
							</a>
						) : null}
					</span>
				}
				actions={
					<>
						<Button onClick={() => check.mutate()} loading={check.isPending} disabled={busy}>
							<IconRefresh size={16} stroke={1.75} />
							Check for updates
						</Button>
						{version.data?.update_available || busy ? (
							<Button
								variant='primary'
								onClick={() => update.mutate()}
								loading={update.isPending}
								disabled={!canUpdate}
							>
								<IconDownload size={16} stroke={1.75} />
								{busy ? 'Updating…' : `Update to ${version.data?.latest}`}
							</Button>
						) : null}
					</>
				}
			>
				{/* A beta tag (v0.1.3-beta.11) is 14 characters: the cells stack before it would truncate. */}
				<Cells className='grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]'>
					<Cell
						label='Installed'
						value={
							<span className='font-mono text-2xl'>
								{version.data?.current ?? <PendingReading label='version' failed={version.isError} />}
							</span>
						}
					/>
					<Cell
						label='Latest'
						value={
							<span
								className={cn('font-mono text-2xl', version.data?.update_available && 'text-warning')}
							>
								{version.data ? (
									version.data.latest || '-'
								) : (
									<PendingReading label='latest version' failed={version.isError} />
								)}
							</span>
						}
						hint={latestHint(version.data)}
					/>
				</Cells>

				<div className='mt-4'>
					{busy ? (
						<UpdateTimeline phase={phase} target={state.data?.target || version.data?.latest || ''} />
					) : (
						<div className='flex flex-col gap-1.5'>
							<span className='text-xs text-muted'>Preflight</span>
							{health.isLoading ? <Skeleton label='Checking health' lines={4} /> : null}
							<ErrorText error={health.error} className='mb-0' />
							{/* A failed refetch keeps the last checks in the cache; showing them would pass old results as current. */}
							{health.isError
								? null
								: checks.map(([name, result]) => (
										<div key={name} className='flex items-baseline gap-2 text-sm'>
											<span className='self-center'>
												<Status value={result === 'ok' ? 'healthy' : 'unhealthy'} dot />
											</span>
											<span className='w-20 font-mono text-xs text-muted'>{name}</span>
											<span className={result === 'ok' ? 'text-muted' : 'text-danger'}>
												{result}
											</span>
										</div>
									))}
							{healthy || health.isLoading ? null : (
								<p className='text-sm text-danger'>
									{health.isError
										? 'Updates wait until the health checks answer.'
										: 'Updates are blocked until the failing checks recover; the server refuses them too.'}
								</p>
							)}
						</div>
					)}
				</div>
			</FormSection>

			<FormSection
				title='Update preferences'
				icon={IconDownload}
				hint='Each change saves on its own. A new channel looks up the latest release on its track.'
			>
				{version.isLoading ? <Skeleton label='Loading update preferences' lines={2} /> : null}
				{version.isError ? (
					<p className='text-sm text-muted'>
						Could not load the preferences. Try again at the top of the page.
					</p>
				) : null}
				{prefs ? (
					<div className='flex flex-col gap-4'>
						<Field
							label='Release channel'
							hint='Pre-release offers only betas, stable only final releases.'
						>
							<Segmented
								label='Channel'
								value={prefs.beta ? 'prerelease' : 'stable'}
								options={channels}
								onChange={channel => save({ beta: channel === 'prerelease' })}
								disabled={setSettings.isPending || busy}
							/>
						</Field>
						<Switch
							label='Remove previous version images after a successful update'
							checked={prefs.cleanup_old_images}
							disabled={setSettings.isPending || busy}
							onChange={cleanup_old_images => save({ cleanup_old_images })}
						/>
					</div>
				) : null}
			</FormSection>
		</div>
	)
}

function UpdateTimeline({ phase, target }: { phase: UpdatePhase; target: string }) {
	// done means every step finished; otherwise everything before the current
	// phase's step is finished and everything after is pending.
	const currentIndex = phase === 'done' ? steps.length : steps.findIndex(step => step.phase === phase)

	return (
		<div className='flex flex-col'>
			<span className='pb-2 font-mono text-sm'>
				{phase === 'done' ? `Updated to ${target}` : `Updating to ${target}`}
			</span>
			<Timeline
				label='Update progress'
				steps={steps.map((step, index) => ({
					id: step.phase,
					name: step.label,
					status: stepStatus(index, currentIndex),
					// Only the step in progress explains itself.
					detail: index === currentIndex ? step.hint : undefined,
				}))}
			/>
		</div>
	)
}

// An empty `latest` means no release was found, so the page cannot claim it is current.
function latestHint(version: VersionStatus | undefined) {
	if (!version) return
	if (version.update_available) return 'update available'
	return version.latest ? 'up to date' : 'no release found'
}

function stepStatus(index: number, current: number) {
	if (index < current) return 'success'
	return index === current ? 'running' : 'queued'
}
