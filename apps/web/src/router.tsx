import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { preload, projectsQuery } from './lib/queries'
import { routeTree } from './routeTree.gen'

/** TanStack Start finds this file by name, so nothing imports it. */
export function getRouter() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				// The panel is a live view of a server: short staleness, no aggressive
				// refetch storms.
				staleTime: 5000,
				retry: 1,
				refetchOnWindowFocus: true,
			},
		},
	})

	// The sidebar's project tree. The root route's loader would run only in the prerendered shell, never on the
	// client's first load, so the fetch starts here to land with the page's own loaders.
	if (typeof window !== 'undefined' && !['/login', '/setup'].includes(window.location.pathname)) {
		void preload(queryClient, projectsQuery)
	}

	return createRouter({
		routeTree,
		context: { queryClient },
		scrollRestoration: true,
		// Hovering a link runs its route's loader, so the data is usually cached by the click.
		defaultPreload: 'intent',
		// The query cache decides freshness; the router's own loader cache would only skip preloads.
		defaultPreloadStaleTime: 0,
	})
}
