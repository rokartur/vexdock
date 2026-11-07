import { useState } from 'react'
import {
	IconArrowRight,
	IconCopy,
	IconPlayerPlay,
	IconPlayerStop,
	IconRocket,
	IconTrash,
	IconX,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Service } from '../lib/api'
import { projectsQuery } from '../lib/queries'
import { Button, Confirm, ErrorText, Field, FormDialog, IconButton, Select } from './primitives'

type Bulk = { kind: 'start' | 'stop' | 'deploy' | 'delete' | 'duplicate' } | { kind: 'move'; environmentId: string }

const pastTense = {
	start: 'Started',
	stop: 'Stopped',
	deploy: 'Queued a deploy for',
	delete: 'Deleted',
	duplicate: 'Duplicated',
	move: 'Moved',
}

// The manager answers 400 to a deploy without a source and to start or stop without a container, and the run stops
// at the first error, so these rows are left out instead of ending a mixed selection halfway.
const needs: Partial<Record<Bulk['kind'], { has: (service: Service) => boolean; lacks: string; fix: string }>> = {
	deploy: {
		has: service => service.provider !== 'unconfigured',
		lacks: 'source',
		fix: 'set one on the General tab',
	},
	start: { has: service => service.state !== '', lacks: 'container', fix: 'deploy first' },
	stop: { has: service => service.state !== '', lacks: 'container', fix: 'deploy first' },
}

export function freeName(base: string, taken: Set<string>) {
	const copy = `${base}-copy`
	if (!taken.has(copy)) return copy
	let suffix = 2
	while (taken.has(`${copy}-${suffix}`)) suffix += 1
	return `${copy}-${suffix}`
}

/**
 * Every action is the single-service endpoint run once per row, in order: each write rewrites the environment's
 * overlay, and parallel writes race for that one file.
 *
 * The state lives in a hook rather than the toolbar because the toolbar sits in the section's header beside its
 * other actions, and an error has no room there: the page renders it under the header from `error`.
 */
export function useServiceBulk({
	services,
	selected,
	onDone,
}: {
	/** Every service of the environment; the names in it decide what a duplicate is called. */
	services: Service[]
	selected: string[]
	onDone: () => void
}) {
	const queryClient = useQueryClient()
	const [moving, setMoving] = useState(false)
	// Taken when the dialog opens: a move's success clears the selection while the dialog is still fading out.
	const [toMove, setToMove] = useState<Service[]>([])
	// The toolbar leaves with the selection, so a screen reader hears the result from the page's status region.
	const [announced, setAnnounced] = useState({ text: '', at: 0 })

	const chosen = services.filter(service => selected.includes(service.id))
	// A delete or move run refetches mid-way and drops rows from `chosen`; the toolbar keeps naming what it acts on.
	const [acting, setActing] = useState<Service[]>([])

	const run = useMutation({
		mutationFn: async (bulk: Bulk) => {
			const taken = new Set(services.map(service => service.compose_service_name))
			const done: string[] = []
			const need = needs[bulk.kind]
			const targets = need ? chosen.filter(need.has) : chosen
			if (need && targets.length === 0)
				throw new Error(
					`${chosen.length === 1 ? 'The selected service has no' : 'None of the selected services has a'} ${need.lacks} yet; ${need.fix}.`,
				)
			/* oxlint-disable no-await-in-loop -- sequential is the point, see above */
			for (const service of targets) {
				try {
					if (bulk.kind === 'move') {
						await api.moveService(service.id, bulk.environmentId)
					} else if (bulk.kind === 'duplicate') {
						const name = freeName(service.compose_service_name, taken)
						taken.add(name)
						await api.duplicateService(service.id, { name })
					} else if (bulk.kind === 'deploy') {
						await api.deployService(service.id)
					} else if (bulk.kind === 'delete') {
						await api.deleteService(service.id)
					} else {
						await api.serviceAction(service.id, bulk.kind)
					}
				} catch (error) {
					// A retry runs the whole selection again, so say which services it would repeat.
					const before = done.length > 0 ? ` Already done for ${done.join(', ')}.` : ''
					const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/u, '')
					throw new Error(`${service.compose_service_name}: ${message}.${before}`, { cause: error })
				}
				done.push(service.compose_service_name)
			}
			/* oxlint-enable no-await-in-loop */
			return { count: done.length, skipped: chosen.length - targets.length }
		},
		onMutate: () => setActing(chosen),
		// The loop stops at the first failure with the services before it already
		// acted on, so a partial run still has to refetch or the table keeps
		// showing their old state. Clearing the selection is onSuccess only: the
		// toolbar leaves with it, and the error belongs on screen. A failed move keeps its dialog open with the error.
		onSuccess: ({ count, skipped }, bulk) => {
			const noun = count === 1 ? 'service' : 'services'
			const rest = skipped > 0 ? `, skipped ${skipped} with no ${needs[bulk.kind]?.lacks} yet` : ''
			setAnnounced({ text: `${pastTense[bulk.kind]} ${count} ${noun}${rest}`, at: Date.now() })
			setMoving(false)
			onDone()
		},
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ['services'] })
			await queryClient.invalidateQueries({ queryKey: ['projects'] })
			await queryClient.invalidateQueries({ queryKey: ['project'] })
			await queryClient.invalidateQueries({ queryKey: ['deployments'] })
		},
	})

	// Clear is the one way out that is not a result, so it takes the last error with it.
	const clear = () => {
		run.reset()
		onDone()
	}

	const openMove = () => {
		// The dialog shows the run's error, so the last action's failure must not greet it.
		run.reset()
		setToMove(chosen)
		setMoving(true)
	}

	return {
		chosen: run.isPending ? acting : chosen,
		run,
		moving,
		setMoving,
		openMove,
		toMove,
		clear,
		// The move dialog shows its own error; the page repeating it would shift under the backdrop.
		error: moving ? null : run.error,
		announced,
	}
}

/** The selection's toolbar, rendered in the section header beside the section's own actions. */
export function ServiceBulkActions({ bulk }: { bulk: ReturnType<typeof useServiceBulk> }) {
	const { chosen, run, openMove, clear } = bulk
	// The pressed action spins and keeps focus; the others wait for it.
	const pending = run.isPending ? run.variables?.kind : undefined
	const waits = (kind: Bulk['kind']) => pending !== undefined && pending !== kind
	const noun = chosen.length === 1 ? 'service' : 'services'
	return (
		<>
			<span className='font-mono text-xs text-muted'>{chosen.length} selected</span>
			<Button
				size='sm'
				onClick={() => run.mutate({ kind: 'start' })}
				disabled={waits('start')}
				loading={pending === 'start'}
			>
				<IconPlayerPlay size={16} stroke={1.75} />
				Start {noun}
			</Button>
			<Confirm
				title={`Stop ${chosen.length} ${noun}?`}
				description={
					chosen.length === 1
						? 'Anything it serves is offline until it starts again.'
						: 'Anything they serve is offline until they start again.'
				}
				action={`Stop ${noun}`}
				icon={IconPlayerStop}
				onConfirm={() => run.mutate({ kind: 'stop' })}
			>
				<Button size='sm' disabled={waits('stop')} loading={pending === 'stop'}>
					<IconPlayerStop size={16} stroke={1.75} />
					Stop {noun}
				</Button>
			</Confirm>
			<Button
				size='sm'
				onClick={() => run.mutate({ kind: 'deploy' })}
				disabled={waits('deploy')}
				loading={pending === 'deploy'}
			>
				<IconRocket size={16} stroke={1.75} />
				Deploy {noun}
			</Button>
			<IconButton
				icon={IconCopy}
				label={`Duplicate selected ${noun}`}
				disabled={waits('duplicate')}
				loading={pending === 'duplicate'}
				onClick={() => run.mutate({ kind: 'duplicate' })}
			/>
			<IconButton
				icon={IconArrowRight}
				label={`Move selected ${noun}`}
				disabled={waits('move')}
				onClick={openMove}
			/>
			<Confirm
				title={`Delete ${chosen.length} ${noun}?`}
				description={
					chosen.length === 1
						? 'Its container is removed and its environment variables deleted. Named volumes stay behind.'
						: 'Their containers are removed and their environment variables deleted. Named volumes stay behind.'
				}
				action={`Delete ${noun}`}
				type='delete'
				onConfirm={() => run.mutate({ kind: 'delete' })}
			>
				<IconButton
					icon={IconTrash}
					label={`Delete selected ${noun}`}
					disabled={waits('delete')}
					loading={pending === 'delete'}
				/>
			</Confirm>
			<Button variant='ghost' size='sm' onClick={clear} disabled={run.isPending}>
				<IconX size={16} stroke={1.75} />
				Clear selection
			</Button>
			{/* Hairline between the selection's actions and the section's own. */}
			<span aria-hidden className='mx-1 h-5 w-px bg-border-subtle' />
		</>
	)
}

/** Mounted by the page beside the toolbar, not in it: the toolbar leaves with the selection. */
export function BulkMoveDialog({ bulk }: { bulk: ReturnType<typeof useServiceBulk> }) {
	const { chosen, run, moving, setMoving, toMove } = bulk
	return (
		<MoveDialog
			key={toMove.map(service => service.id).join(',')}
			open={moving}
			// Open, it counts what a retry would move: a half-failed run's refetch drops the services already moved.
			count={moving ? chosen.length : toMove.length}
			from={toMove[0]?.environment_id}
			mutation={run}
			onOpenChange={setMoving}
			onMove={environmentId => run.mutate({ kind: 'move', environmentId })}
		/>
	)
}

function MoveDialog({
	open,
	count,
	from,
	mutation,
	onOpenChange,
	onMove,
}: {
	open: boolean
	count: number
	/** The environment the services are in; moving there is refused, so it is not offered. */
	from: string | undefined
	mutation: { isPending: boolean; error: unknown; reset: () => void }
	onOpenChange: (open: boolean) => void
	onMove: (environmentId: string) => void
}) {
	const [projectId, setProjectId] = useState('')
	const [environmentId, setEnvironmentId] = useState('')

	const projects = useQuery({ ...projectsQuery, enabled: open })
	const targets = projects.data ?? []
	const project = targets.find(candidate => candidate.id === projectId)
	const environments = (project?.environments ?? []).filter(candidate => candidate.id !== from)
	const environment = environments.find(candidate => candidate.id === environmentId)
	let environmentHint = 'Pick an environment'
	if (!project) environmentHint = 'Pick a project first'
	else if (environments.length === 0) environmentHint = 'No other environment here'

	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			title={`Move ${count} service${count === 1 ? '' : 's'}`}
			description={
				count === 1
					? 'Domains and scheduled tasks follow the service. Volume data is copied, and its container is removed until the next deploy.'
					: 'Domains and scheduled tasks follow the services. Volume data is copied, and the containers are removed until the next deploy.'
			}
			action={count === 1 ? 'Move service' : 'Move services'}
			icon={IconArrowRight}
			mutation={mutation}
			disabled={!environment}
			onSubmit={() => {
				if (environment) onMove(environment.id)
			}}
		>
			<ErrorText error={projects.error} />
			<Field label='Project'>
				<Select
					value={projectId}
					placeholder={projects.isPending ? 'Loading projects…' : 'Pick a project'}
					disabled={projects.isPending}
					options={targets.map(candidate => ({ value: candidate.id, label: candidate.name }))}
					onChange={next => {
						setProjectId(next)
						setEnvironmentId('')
					}}
				/>
			</Field>
			<Field label='Environment'>
				<Select
					value={environment?.id ?? ''}
					placeholder={environmentHint}
					options={environments.map(candidate => ({ value: candidate.id, label: candidate.name }))}
					onChange={setEnvironmentId}
					disabled={!project || environments.length === 0}
				/>
			</Field>
		</FormDialog>
	)
}
