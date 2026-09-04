import { useEffect, useState } from 'react'
import { IconLayersLinked, IconVariable, type Icon as TablerIcon } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ErrorText, FormSection, SaveButton, Textarea } from '../components/primitives'
import { api, type EnvVar } from '../lib/api'
import { fromDotenv, toDotenv } from '../lib/dotenv'
import { useEnvironmentId } from '../lib/environment'

export const Route = createFileRoute('/projects/$projectId/environment')({ component: ProjectEnvironment })

/**
 * Two sets of variables end up in one .env: the project's, which every
 * environment gets, and the environment's own, which win on a collision. They
 * are edited as .env text so a file can be pasted in whole.
 */
function ProjectEnvironment() {
	const { projectId } = Route.useParams()
	const selected = useEnvironmentId()
	const environments = useQuery({ queryKey: ['environments', projectId], queryFn: () => api.environments(projectId) })
	const current = environments.data?.find(env => (selected ? env.id === selected : env.is_default))

	return (
		<div className='max-w-3xl'>
			<VariablesEditor
				title='Shared variables'
				description='Every environment of this project gets these.'
				icon={IconVariable}
				queryKey={['variables', 'project', projectId]}
				load={() => api.projectVariables(projectId)}
				save={variables => api.saveProjectVariables(projectId, variables)}
			/>
			{current ? (
				<VariablesEditor
					title={`${current.name} variables`}
					description='Override a shared value, or add one only this environment needs.'
					icon={IconLayersLinked}
					queryKey={['variables', 'environment', current.id]}
					load={() => api.environmentVariables(current.id)}
					save={variables => api.saveEnvironmentVariables(current.id, variables)}
				/>
			) : null}
		</div>
	)
}

function VariablesEditor({
	title,
	description,
	icon,
	queryKey,
	load,
	save,
}: {
	title: string
	description: string
	icon: TablerIcon
	queryKey: string[]
	load: () => Promise<EnvVar[]>
	save: (variables: EnvVar[]) => Promise<EnvVar[]>
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
			hint='One KEY=value per line. Redeploy to apply.'
			onSave={() => write.mutate()}
			actions={<SaveButton pending={write.isPending} />}
		>
			<ErrorText error={write.error} />
			<Textarea
				rows={12}
				value={text}
				placeholder='KEY=value'
				onChange={event => setText(event.target.value)}
				spellCheck={false}
			/>
		</FormSection>
	)
}
