import { retainSearchParams, useSearch } from '@tanstack/react-router'

/**
 * What puts `env` in the URL and keeps it there. Spread into the two route
 * branches that act on an environment: the project layout and the service
 * layout beneath it.
 *
 * In the URL rather than in a store, so a pasted link lands on the same
 * environment it was copied from. Retaining it keeps every tab click from
 * silently falling back to the default one.
 */
export const environmentSearch = {
	validateSearch: (search: Record<string, unknown>): EnvironmentSearch =>
		typeof search.env === 'string' ? { env: search.env } : {},
	search: { middlewares: [retainSearchParams<EnvironmentSearch>(['env'])] },
}

type EnvironmentSearch = { env?: string }

/**
 * The environment a project page acts on, read from the URL so a link to
 * staging stays a link to staging.
 *
 * `undefined` means the project's default environment. That is what every
 * link written before environments existed resolves to, and what the manager
 * falls back to when the query string omits one.
 */
export function useEnvironmentId(): string | undefined {
	// Read loosely: the project's pages and the service pages below them are
	// separate route branches, and both carry `env`.
	return useSearch({ strict: false }).env
}
