import { useSearch } from '@tanstack/react-router'

/**
 * The environment a project page acts on, read from the URL so a link to
 * staging stays a link to staging.
 *
 * `undefined` means the project's default environment. That is what every
 * link written before environments existed resolves to, and what the manager
 * falls back to when the query string omits one.
 */
export function useEnvironmentId(): string | undefined {
	return useSearch({ from: '/projects/$projectId' }).env
}
