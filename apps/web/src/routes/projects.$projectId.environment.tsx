import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Check, ErrorText, Section } from '../components/primitives'
import { api, type EnvVar } from '../lib/api'

export const Route = createFileRoute('/projects/$projectId/environment')({ component: ProjectEnvironment })

/**
 * Secret values arrive masked. Leaving a masked value untouched keeps the
 * stored secret; typing over it replaces it.
 */
function ProjectEnvironment() {
	const { projectId } = Route.useParams()
	const queryClient = useQueryClient()
	const [rows, setRows] = useState<EnvVar[]>([])

	const environment = useQuery({
		queryKey: ['environment', projectId],
		queryFn: () => api.environment(projectId),
	})

	useEffect(() => {
		if (environment.data) setRows(environment.data)
	}, [environment.data])

	const save = useMutation({
		mutationFn: () => api.saveEnvironment(projectId, rows),
		onSuccess: saved => {
			setRows(saved)
			void queryClient.invalidateQueries({ queryKey: ['environment', projectId] })
		},
	})

	const update = (index: number, patch: Partial<EnvVar>) =>
		setRows(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))

	return (
		<Section
			title='Environment variables'
			description='written to the project .env with 0600 permissions'
			actions={
				<>
					<Button
						onClick={() =>
							setRows(current => [...current, { key: '', value: '', is_secret: true, updated_at: '' }])
						}
					>
						Add variable
					</Button>
					<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
						{save.isPending ? 'Saving…' : 'Save'}
					</Button>
				</>
			}
		>
			<ErrorText error={save.error} />
			<div className='border-t border-border'>
				{rows.length === 0 ? (
					<p className='py-6 text-body text-muted-foreground'>
						No variables. Add one and redeploy to apply it.
					</p>
				) : (
					rows.map((row, index) => (
						<div key={index} className='flex items-center gap-2 border-b border-border/50 py-1.5'>
							<input
								value={row.key}
								placeholder='KEY'
								onChange={event => update(index, { key: event.target.value })}
								className='!w-56 font-mono text-body'
							/>
							<input
								value={row.value}
								placeholder='value'
								type={row.is_secret ? 'password' : 'text'}
								onChange={event => update(index, { value: event.target.value })}
								className='flex-1 font-mono text-body'
							/>
							<Check
								label='secret'
								muted
								className='shrink-0'
								checked={row.is_secret}
								onChange={is_secret => update(index, { is_secret })}
							/>
							<Button
								variant='ghost'
								onClick={() => setRows(current => current.filter((_, i) => i !== index))}
							>
								remove
							</Button>
						</div>
					))
				)}
			</div>
		</Section>
	)
}
