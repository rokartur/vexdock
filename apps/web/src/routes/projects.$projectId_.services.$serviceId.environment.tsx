import { useEffect, useState } from 'react'
import { IconVariable } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { VariablesEditor } from '../components/env-editor'
import { ErrorText, FormSection, SaveButton } from '../components/primitives'
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
				hint='Redeploy to apply.'
				onSave={() => save.mutate()}
				actions={<SaveButton mutation={save} />}
			>
				<ErrorText error={save.error} />
				<VariablesEditor rows={18} value={text} onChange={setText} stored={environment.data ?? []} />
			</FormSection>
		</div>
	)
}
