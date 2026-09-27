import { type FetchQueryOptions, type QueryClient, type QueryKey, queryOptions } from '@tanstack/react-query'
import { api } from './api'

export const projectsQuery = queryOptions({ queryKey: ['projects'], queryFn: api.projects })
export const containersQuery = queryOptions({ queryKey: ['containers'], queryFn: api.containers })
export const systemInfoQuery = queryOptions({ queryKey: ['system', 'info'], queryFn: api.systemInfo })
export const certificatesQuery = queryOptions({ queryKey: ['certificates'], queryFn: api.certificates })
export const versionQuery = queryOptions({ queryKey: ['version'], queryFn: api.version })
export const healthQuery = queryOptions({ queryKey: ['health'], queryFn: api.health })
export const gitProvidersQuery = queryOptions({ queryKey: ['git-providers'], queryFn: api.gitProviders })
export const updateStateQuery = queryOptions({ queryKey: ['update-state'], queryFn: api.updateState, retry: false })
export const projectQuery = (projectId: string) =>
	queryOptions({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) })
/** Without a service, every task on the server. */
export const tasksQuery = (serviceId?: string) =>
	queryOptions({
		queryKey: serviceId ? ['service', serviceId, 'tasks'] : ['tasks'],
		queryFn: () => (serviceId ? api.serviceTasks(serviceId) : api.tasks()),
	})
export const environmentsQuery = (projectId: string) =>
	queryOptions({ queryKey: ['environments', projectId], queryFn: () => api.environments(projectId) })
export const servicesQuery = (projectId: string, environmentId: string | undefined) =>
	queryOptions({
		queryKey: ['services', projectId, environmentId],
		queryFn: () => api.services(projectId, environmentId),
	})
export const deploymentsQuery = (projectId: string, environmentId: string | undefined) =>
	queryOptions({
		queryKey: ['deployments', projectId, environmentId],
		queryFn: () => api.deployments(projectId, environmentId),
	})
export const projectDomainsQuery = (projectId: string) =>
	queryOptions({ queryKey: ['domains', projectId], queryFn: () => api.projectDomains(projectId) })
export const serviceQuery = (serviceId: string) =>
	queryOptions({ queryKey: ['service', serviceId], queryFn: () => api.service(serviceId) })

/**
 * For a route loader: resolves once the query holds data or an error, so the router keeps the old page up until the
 * new one can paint whole. A cached query, stale or not, resolves at once and the page refetches it behind the data.
 * Never rejects; the page's own `useQuery` shows the error where it always did.
 */
export function preload<T, K extends QueryKey>(queryClient: QueryClient, query: FetchQueryOptions<T, Error, T, K>) {
	return queryClient.prefetchQuery({ ...query, staleTime: Number.POSITIVE_INFINITY })
}
