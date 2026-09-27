import { useEffect, useState } from 'react'
import { IconLayersLinked, IconVariable, type Icon as TablerIcon } from '@tabler/icons-react'
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { VariablesEditor } from '../components/env-editor'
import { ErrorText, FormSection, SaveButton } from '../components/primitives'
import { api, type EnvVar } from '../lib/api'
import { fromDotenv, toDotenv } from '../lib/dotenv'
import { useCurrentEnvironment } from '../lib/environment'
import { environmentsQuery, preload } from '../lib/queries'

const sharedVariablesQuery = (projectId: string) =>
	queryOptions({ queryKey: ['variables', 'project', projectId], queryFn: () => api.projectVariables(projectId) })
const environmentVariablesQuery = (environmentId: string) =>
	queryOptions({
		queryKey: ['variables', 'environment', environmentId],
		queryFn: () => api.environmentVariables(environmentId),
	})

export const Route = createFileRoute('/projects/$projectId/environment')({
	loaderDeps: ({ search }) => ({ env: search.env }),
	loader: ({ context: { queryClient }, params: { projectId }, deps: { env } }) =>
		Promise.all([
			preload(queryClient, sharedVariablesQuery(projectId)),
			preloadEnvironmentVariables(queryClient, projectId, env),
		]),
	component: ProjectEnvironment,
})

async function preloadEnvironmentVariables(queryClient: QueryClient, projectId: string, env: string | undefined) {
	await preload(queryClient, environmentsQuery(projectId))
	const environments = queryClient.getQueryData(environmentsQuery(projectId).queryKey)
	const current = environments?.find(environment => (env ? environment.id === env : environment.is_default))
	if (current) await preload(queryClient, environmentVariablesQuery(current.id))
}

/** The project's variables reach every environment, the environment's own win on a collision. Edited as .env text. */
function ProjectEnvironment() {
	const { projectId } = Route.useParams()
	const { current } = useCurrentEnvironment(projectId)

	// Same query as the card below, so the two share one fetch: the environment card needs the shared
	// keys to mark the ones it overrides.
	const sharedQuery = sharedVariablesQuery(projectId)
	const shared = useQuery(sharedQuery)

	return (
		<div className='max-w-3xl'>
			<VariablesCard
				title='Shared variables'
				description='Every environment of this project gets these.'
				icon={IconVariable}
				query={sharedQuery}
				save={variables => api.saveProjectVariables(projectId, variables)}
			/>
			{current ? (
				<VariablesCard
					key={current.id}
					title={`${current.name} variables`}
					description='Override a shared value, or add one only this environment needs.'
					icon={IconLayersLinked}
					query={environmentVariablesQuery(current.id)}
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
	query,
	save,
	shared,
}: {
	title: string
	description: string
	icon: TablerIcon
	query: ReturnType<typeof sharedVariablesQuery>
	save: (variables: EnvVar[]) => Promise<EnvVar[]>
	shared?: EnvVar[]
}) {
	const queryClient = useQueryClient()
	const [text, setText] = useState('')

	const variables = useQuery(query)

	useEffect(() => {
		if (variables.data) setText(toDotenv(variables.data))
	}, [variables.data])

	const write = useMutation({
		// The previous values are passed along so an untouched secret keeps its
		// stored value instead of being overwritten with its own placeholder.
		mutationFn: () => save(fromDotenv(text, variables.data ?? [])),
		onSuccess: saved => {
			setText(toDotenv(saved))
			void queryClient.invalidateQueries({ queryKey: query.queryKey })
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
