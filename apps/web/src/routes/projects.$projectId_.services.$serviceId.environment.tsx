import { useEffect, useState } from 'react'
import { IconVariable } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ErrorText, FormSection, SaveButton, Textarea } from '../components/primitives'
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
		<div className='max-w-3xl'>
			<FormSection
				title='Environment variables'
				description='Written to this service’s own .env with 0600 permissions.'
				icon={IconVariable}
				hint='One KEY=value per line. Redeploy to apply.'
				onSave={() => save.mutate()}
				actions={<SaveButton pending={save.isPending} />}
			>
				<ErrorText error={save.error} />
				<Textarea
					rows={18}
					value={text}
					placeholder='KEY=value'
					onChange={event => setText(event.target.value)}
					spellCheck={false}
				/>
			</FormSection>
		</div>
	)
}
