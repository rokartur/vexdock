import { IconHome, IconRefresh } from '@tabler/icons-react'
import { QueryClient } from '@tanstack/react-query'
import { createRouter, type ErrorComponentProps, Link, useRouter, useRouterState } from '@tanstack/react-router'
import { Button, EmptyState, Page } from './components/primitives'
import { Alert } from './components/ui/alert'
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
	// A shared analytics report has no session either, and a 401 here would send its reader to sign in.
	if (
		typeof window !== 'undefined' &&
		!['/login', '/setup'].includes(window.location.pathname) &&
		!window.location.pathname.startsWith('/shared/')
	) {
		void preload(queryClient, projectsQuery)
	}

	const router = createRouter({
		routeTree,
		context: { queryClient },
		scrollRestoration: true,
		// `main` scrolls, not the window: a new page starts at its top and Back returns to where it was. Without this
		// the router hands the last page's offset to the next one.
		scrollToTopSelectors: ['main[data-content]'],
		// Hovering a link runs its route's loader, so the data is usually cached by the click.
		defaultPreload: 'intent',
		// The query cache decides freshness; the router's own loader cache would only skip preloads.
		defaultPreloadStaleTime: 0,
		defaultNotFoundComponent: NotFound,
		defaultErrorComponent: PageError,
		// A route whose chunk or loader takes longer than this shows PagePending, held at least pendingMinMs (500).
		defaultPendingMs: 300,
		defaultPendingComponent: PagePending,
		// The Page swap recipe: a new page swaps `main[data-content]` (styles.css). A search change and a tab of the same
		// layout re-render in place, so what the layout keeps on screen (a service's FactBar) never swaps with itself.
		defaultViewTransition: {
			types: ({ pathChanged, fromLocation, toLocation }): string[] | false => {
				if (!pathChanged) return false
				const layout = fromLocation && layoutOf(fromLocation.pathname)
				return layout && layout === layoutOf(toLocation.pathname) ? false : ['page']
			},
		},
	})

	// The part of the path a layout route (a Page with tabs) owns, or undefined on a page without one.
	function layoutOf(pathname: string) {
		const [[, layout, tab]] = router.getMatchedRoutes(pathname)
		if (!layout || !tab) return
		return pathname.split('/').slice(0, layout.fullPath.split('/').length).join('/')
	}

	return router
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
	// Inside a layout's Page this is only its body; at the root it is the whole page, header and main included.
	return (
		<Page>
			<EmptyState scene='map' title='Nothing lives at this address'>
				<Button render={<Link to='/' />}>
					<IconHome size={16} stroke={1.75} />
					Back to the dashboard
				</Button>
			</EmptyState>
		</Page>
	)
}

/** A loader that failed or a page that threw. Reloading the route's data also resets the boundary. */
function PageError({ error }: ErrorComponentProps) {
	const router = useRouter()
	const reloading = useRouterState({ select: state => state.isLoading })
	return (
		<Page>
			<Alert tone='danger' title={error instanceof Error ? error.message : String(error)}>
				<Button loading={reloading} onClick={() => router.invalidate()}>
					<IconRefresh size={16} stroke={1.75} />
					Try again
				</Button>
			</Alert>
		</Page>
	)
}
