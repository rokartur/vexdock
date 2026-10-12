import { useState } from 'react'
import { IconArrowRight, IconCopy, IconPlayerPlay, IconPlayerStop, IconRocket, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { api, type Service } from '../lib/api'
import { Button, Confirm, DialogFooter, Field, IconButton, Select } from './primitives'

type Bulk = { kind: 'start' | 'stop' | 'deploy' | 'delete' | 'duplicate' } | { kind: 'move'; environmentId: string }

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

	const chosen = services.filter(service => selected.includes(service.id))

	const run = useMutation({
		mutationFn: async (bulk: Bulk) => {
			const taken = new Set(services.map(service => service.compose_service_name))
			/* oxlint-disable no-await-in-loop -- sequential is the point, see above */
			for (const service of chosen) {
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
					throw new Error(
						`${service.compose_service_name}: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					)
				}
			}
			/* oxlint-enable no-await-in-loop */
		},
		// The loop stops at the first failure with the services before it already
		// acted on, so a partial run still has to refetch or the table keeps
		// showing their old state. Clearing the selection is onSuccess only: the
		// toolbar leaves with it, and the error belongs on screen.
		onSuccess: () => onDone(),
		onSettled: async () => {
			setMoving(false)
			await queryClient.invalidateQueries({ queryKey: ['services'] })
			await queryClient.invalidateQueries({ queryKey: ['projects'] })
			await queryClient.invalidateQueries({ queryKey: ['project'] })
		},
	})

	// Clear is the one way out that is not a result, so it takes the last error with it.
	const clear = () => {
		run.reset()
		onDone()
	}

	return { chosen, run, moving, setMoving, clear, error: run.error }
}

/** The selection's toolbar, rendered in the section header beside the section's own actions. */
export function ServiceBulkActions({ bulk }: { bulk: ReturnType<typeof useServiceBulk> }) {
	const { chosen, run, moving, setMoving, clear } = bulk
	return (
		<>
			<span className='font-mono text-xs text-muted'>{chosen.length} selected</span>
			<Button onClick={() => run.mutate({ kind: 'start' })} disabled={run.isPending}>
				<IconPlayerPlay />
				Start
			</Button>
			<Button onClick={() => run.mutate({ kind: 'stop' })} disabled={run.isPending}>
				<IconPlayerStop />
				Stop
			</Button>
			<Button onClick={() => run.mutate({ kind: 'deploy' })} disabled={run.isPending}>
				<IconRocket />
				Deploy
			</Button>
			<IconButton
				icon={IconCopy}
				label='Duplicate'
				size='default'
				disabled={run.isPending}
				onClick={() => run.mutate({ kind: 'duplicate' })}
			/>
			<IconButton
				icon={IconArrowRight}
				label='Move'
				size='default'
				disabled={run.isPending}
				onClick={() => setMoving(true)}
			/>
			<Confirm
				title={`Delete ${chosen.length} service${chosen.length === 1 ? '' : 's'}?`}
				description='Their containers are removed. Named volumes stay behind.'
				onConfirm={() => run.mutate({ kind: 'delete' })}
			>
				<IconButton icon={IconTrash} label='Delete' size='default' disabled={run.isPending} />
			</Confirm>
			<Button variant='ghost' onClick={clear} disabled={run.isPending}>
				Clear
			</Button>
			{/* Hairline between the selection's actions and the section's own. */}
			<span aria-hidden className='mx-1 h-5 w-px bg-border-subtle' />
			<MoveDialog
				open={moving}
				count={chosen.length}
				pending={run.isPending}
				onCancel={() => setMoving(false)}
				onMove={environmentId => run.mutate({ kind: 'move', environmentId })}
			/>
		</>
	)
}

function MoveDialog({
	open,
	count,
	pending,
	onCancel,
	onMove,
}: {
	open: boolean
	count: number
	pending: boolean
	onCancel: () => void
	onMove: (environmentId: string) => void
}) {
	const [projectId, setProjectId] = useState('')
	const [environmentId, setEnvironmentId] = useState('')

	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: open })
	const targets = projects.data ?? []
	const project = targets.find(candidate => candidate.id === projectId)
	const environments = project?.environments ?? []
	const environment = environments.find(candidate => candidate.id === environmentId) ?? environments[0]

	return (
		<Dialog open={open} onOpenChange={next => !next && onCancel()}>
			<DialogContent title={`Move ${count} service${count === 1 ? '' : 's'}`}>
				<Field label='Project'>
					<Select
						value={projectId}
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
						options={environments.map(candidate => ({ value: candidate.id, label: candidate.name }))}
						onChange={setEnvironmentId}
						disabled={!project}
					/>
				</Field>
				<p className='mb-3 text-xs text-muted'>
					Domains and scheduled tasks follow the service. Volume data is copied, and the containers are
					removed until the next deploy.
				</p>
				<DialogFooter>
					<Button variant='ghost' onClick={onCancel}>
						Cancel
					</Button>
					<Button
						variant='primary'
						disabled={!environment}
						loading={pending}
						onClick={() => environment && onMove(environment.id)}
					>
						<IconArrowRight />
						Move
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
