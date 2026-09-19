import { useQuery } from '@tanstack/react-query'
import { retainSearchParams, useSearch } from '@tanstack/react-router'
import { api } from './api'

/** Spread into the project and service route branches. In the URL, not a store, so a pasted link lands where it
 * was copied from. */
export const environmentSearch = {
	validateSearch: (search: Record<string, unknown>): EnvironmentSearch =>
		typeof search.env === 'string' ? { env: search.env } : {},
	search: { middlewares: [retainSearchParams<EnvironmentSearch>(['env'])] },
}

type EnvironmentSearch = { env?: string }

/** `undefined` means the project's default environment, which is what the manager falls back to. */
export function useEnvironmentId(): string | undefined {
	// Read loosely: the project's pages and the service pages below them are
	// separate route branches, and both carry `env`.
	return useSearch({ strict: false }).env
}

/** The environment the page is acting on, and the list it came from. One query key, so every caller shares the fetch. */
export function useCurrentEnvironment(projectId: string) {
	const selected = useEnvironmentId()
	const environments = useQuery({ queryKey: ['environments', projectId], queryFn: () => api.environments(projectId) })
	return { environments, current: environments.data?.find(env => (selected ? env.id === selected : env.is_default)) }
}
