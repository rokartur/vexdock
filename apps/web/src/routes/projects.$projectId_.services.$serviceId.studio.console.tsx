import { useState } from 'react'
import { IconPlayerPlay } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, EmptyState, ErrorText, Keys, mod, Textarea } from '../components/primitives'
import { StudioGrid } from '../components/studio-grid'
import { api } from '../lib/api'
import { useService } from './projects.$projectId_.services.$serviceId'
import { useStudio } from './projects.$projectId_.services.$serviceId.studio'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/studio/console')({
	component: StudioConsole,
})

const placeholders: Record<string, string> = { mongodb: '{"ping": 1}', valkey: 'PING' }

function StudioConsole() {
	const { serviceId } = Route.useParams()
	const service = useService(serviceId)
	const { schema } = useStudio()
	const queryClient = useQueryClient()
	const [query, setQuery] = useState('')
	const run = useMutation({
		mutationFn: () => api.studioQuery(serviceId, { schema: schema?.name ?? '', query }),
		// A console statement can create, alter or fill a table, so the sidebar and every grid reload.
		onSettled: () => queryClient.invalidateQueries({ queryKey: ['studio', serviceId] }),
	})
	const result = run.data

	return (
		<>
			<form
				className='flex flex-col gap-2 border-b p-3'
				onSubmit={event => {
					event.preventDefault()
					run.mutate()
				}}
			>
				<Textarea
					mono
					aria-label='Query'
					placeholder={placeholders[service.data?.engine ?? ''] ?? 'select 1'}
					value={query}
					onChange={event => setQuery(event.target.value)}
					onKeyDown={event => {
						if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
						event.preventDefault()
						event.currentTarget.form?.requestSubmit()
					}}
				/>
				<div className='flex items-center gap-3'>
					<Button type='submit' variant='primary' disabled={!query.trim() || run.isPending}>
						<IconPlayerPlay />
						Run
						<Keys keys={[mod, 'Enter']} />
					</Button>
					{result ? (
						<span className='text-label text-muted-foreground tabular-nums'>
							{result.columns.length > 0
								? `${count(result.rows.length)} rows`
								: `${count(result.affected)} affected`}
							{result.truncated ? ', the first ones only' : ''} in {count(result.duration_ms)} ms
						</span>
					) : null}
				</div>
			</form>
			{run.error ? (
				<div className='p-3'>
					<ErrorText error={run.error} />
				</div>
			) : null}
			{result && result.columns.length > 0 ? (
				<StudioGrid
					columns={result.columns.map(name => ({ name }))}
					rows={result.rows.map((cells, index) => ({ id: String(index), cells }))}
				/>
			) : null}
			{result && result.columns.length === 0 ? <EmptyState title='The statement returned no rows.' /> : null}
		</>
	)
}

const count = (value: number) => value.toLocaleString('en-US')
