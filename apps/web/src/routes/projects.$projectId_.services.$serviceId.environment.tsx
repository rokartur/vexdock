import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, ErrorText, Section } from '../components/primitives'
import { api } from '../lib/api'
import { fromDotenv, toDotenv } from '../lib/dotenv'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/environment')({
	component: ServiceEnvironment,
})

/**
 * Managed services get their own .env file, so their credentials never collide
 * with a sibling running the same engine.
 */
function ServiceEnvironment() {
	const { serviceId } = Route.useParams()
	const queryClient = useQueryClient()
	const [text, setText] = useState('')

	const environment = useQuery({
		queryKey: ['service', serviceId, 'environment'],
		queryFn: () => api.serviceVariables(serviceId),
	})

	useEffect(() => {
		if (environment.data) setText(toDotenv(environment.data))
	}, [environment.data])

	const save = useMutation({
		mutationFn: () => api.saveServiceVariables(serviceId, fromDotenv(text, environment.data ?? [])),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', serviceId, 'environment'] }),
	})

	return (
		<Section
			title='Environment variables'
			description='written to this service’s own .env with 0600 permissions'
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
			<p className='mt-1 text-label text-muted-foreground'>One KEY=value per line. Redeploy to apply.</p>
		</Section>
	)
}
