import { QueryClient } from '@tanstack/react-query'
import { createRouter, Link } from '@tanstack/react-router'
import { Button, EmptyState, Page } from './components/primitives'
import { Skeleton } from './components/ui/skeleton'
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
		defaultNotFoundComponent: NotFound,
		// A route whose chunk or loader takes longer than this shows PagePending, held at least pendingMinMs (500).
		defaultPendingMs: 300,
		defaultPendingComponent: PagePending,
	})
}

function PagePending() {
	return (
		<Page>
			<div className='rounded-surface border bg-surface p-5'>
				<Skeleton label='Loading page' lines={4} />
			</div>
		</Page>
	)
}

function NotFound() {
	return (
		<EmptyState scene='map' title='Page not found' description='Nothing lives at this address.'>
			<Button render={<Link to='/' />}>Back to the dashboard</Button>
		</EmptyState>
	)
}
