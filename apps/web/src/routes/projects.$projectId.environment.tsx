import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, ErrorText, Section } from '../components/primitives'
import { api } from '../lib/api'
import { fromDotenv, toDotenv } from '../lib/dotenv'

export const Route = createFileRoute('/projects/$projectId/environment')({ component: ProjectEnvironment })

/**
 * The environment is edited as .env text, so a file can be pasted in whole.
 */
function ProjectEnvironment() {
	const { projectId } = Route.useParams()
	const queryClient = useQueryClient()
	const [text, setText] = useState('')

	const environment = useQuery({
		queryKey: ['environment', projectId],
		queryFn: () => api.environment(projectId),
	})

	useEffect(() => {
		if (environment.data) setText(toDotenv(environment.data))
	}, [environment.data])

	const save = useMutation({
		mutationFn: () => api.saveEnvironment(projectId, fromDotenv(text, environment.data ?? [])),
		onSuccess: saved => {
			setText(toDotenv(saved))
			void queryClient.invalidateQueries({ queryKey: ['environment', projectId] })
		},
	})

	return (
		<Section
			title='Environment variables'
			description='written to the project .env with 0600 permissions'
			onSave={() => save.mutate()}
			actions={
				<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save'}
				</Button>
			}
		>
			<ErrorText error={save.error} />
			<textarea
				rows={18}
				value={text}
				placeholder='KEY=value'
				onChange={event => setText(event.target.value)}
				className='font-mono text-body'
				spellCheck={false}
			/>
			<p className='mt-1 text-label text-muted-foreground'>
				One KEY=value per line. Redeploy to apply.
			</p>
		</Section>
	)
}
