import { IconLayersLinked, IconVariable } from '@tabler/icons-react'
import { type QueryClient, queryOptions, type UseQueryResult, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { VariablesCard } from '../components/env-editor'
import { ErrorText, FormSkeleton } from '../components/primitives'
import { api, type Environment } from '../lib/api'
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
	const { environments, current } = useCurrentEnvironment(projectId)

	// Same query as the card below, so the two share one fetch: the environment card needs the shared
	// keys to mark the ones it overrides.
	const sharedQuery = sharedVariablesQuery(projectId)
	const shared = useQuery(sharedQuery)

	return (
		<div className='max-w-3xl'>
			<VariablesCard
				key={projectId}
				title='Shared variables'
				icon={IconVariable}
				query={sharedQuery}
				save={variables => api.saveProjectVariables(projectId, variables)}
			/>
			{current ? (
				<VariablesCard
					key={current.id}
					title={`${current.name} variables`}
					icon={IconLayersLinked}
					query={environmentVariablesQuery(current.id)}
					save={variables => api.saveEnvironmentVariables(current.id, variables)}
					shared={shared.data ?? []}
				/>
			) : (
				<EnvironmentPending environments={environments} />
			)}
		</div>
	)
}

/** Stands in for the environment's card until the environment is known, so its variables never vanish unexplained. */
function EnvironmentPending({ environments }: { environments: UseQueryResult<Environment[]> }) {
	if (environments.isPending) return <FormSkeleton label='Loading variables' cards={1} />
	if (environments.isError) return <ErrorText error={environments.error} />
	return <ErrorText error='This environment no longer exists. Pick another one from the breadcrumb.' />
}
