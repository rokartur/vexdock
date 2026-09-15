import { useEffect, useState } from 'react'
import { IconLayersLinked, IconVariable, type Icon as TablerIcon } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { VariablesEditor } from '../components/env-editor'
import { ErrorText, FormSection, SaveButton } from '../components/primitives'
import { api, type EnvVar } from '../lib/api'
import { fromDotenv, toDotenv } from '../lib/dotenv'
import { useEnvironmentId } from '../lib/environment'

export const Route = createFileRoute('/projects/$projectId/environment')({ component: ProjectEnvironment })

/** The project's variables reach every environment, the environment's own win on a collision. Edited as .env text. */
function ProjectEnvironment() {
	const { projectId } = Route.useParams()
	const selected = useEnvironmentId()
	const environments = useQuery({ queryKey: ['environments', projectId], queryFn: () => api.environments(projectId) })
	const current = environments.data?.find(env => (selected ? env.id === selected : env.is_default))

	// Same key as the card below, so the two share one fetch: the environment card needs the shared
	// keys to mark the ones it overrides.
	const sharedKey = ['variables', 'project', projectId]
	const shared = useQuery({ queryKey: sharedKey, queryFn: () => api.projectVariables(projectId) })

	return (
		<div className='max-w-3xl'>
			<VariablesCard
				title='Shared variables'
				description='Every environment of this project gets these.'
				icon={IconVariable}
				queryKey={sharedKey}
				load={() => api.projectVariables(projectId)}
				save={variables => api.saveProjectVariables(projectId, variables)}
			/>
			{current ? (
				<VariablesCard
					title={`${current.name} variables`}
					description='Override a shared value, or add one only this environment needs.'
					icon={IconLayersLinked}
					queryKey={['variables', 'environment', current.id]}
					load={() => api.environmentVariables(current.id)}
					save={variables => api.saveEnvironmentVariables(current.id, variables)}
					shared={shared.data ?? []}
				/>
			) : null}
		</div>
	)
}

function VariablesCard({
	title,
	description,
	icon,
	queryKey,
	load,
	save,
	shared,
}: {
	title: string
	description: string
	icon: TablerIcon
	queryKey: string[]
	load: () => Promise<EnvVar[]>
	save: (variables: EnvVar[]) => Promise<EnvVar[]>
	shared?: EnvVar[]
}) {
	const queryClient = useQueryClient()
	const [text, setText] = useState('')

	const variables = useQuery({ queryKey, queryFn: load })

	useEffect(() => {
		if (variables.data) setText(toDotenv(variables.data))
	}, [variables.data])

	const write = useMutation({
		// The previous values are passed along so an untouched secret keeps its
		// stored value instead of being overwritten with its own placeholder.
		mutationFn: () => save(fromDotenv(text, variables.data ?? [])),
		onSuccess: saved => {
			setText(toDotenv(saved))
			void queryClient.invalidateQueries({ queryKey })
		},
	})

	return (
		<FormSection
			title={title}
			description={description}
			icon={icon}
			hint='Redeploy to apply.'
			onSave={() => write.mutate()}
			actions={<SaveButton mutation={write} />}
		>
			<ErrorText error={write.error} />
			<VariablesEditor value={text} onChange={setText} stored={variables.data ?? []} shared={shared} />
		</FormSection>
	)
}
