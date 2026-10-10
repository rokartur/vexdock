import type { ReactNode } from 'react'
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts, useRouterState } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { ArcProvider, type ArcLinkProps } from '@/components/arc/arc-provider'
import { TooltipProvider } from '@/components/arc/tooltip'
import { AuthGate } from '../components/auth-gate'
import { Shell } from '../components/shell'
// Side-effect import: Vite emits and injects the hashed stylesheet itself.
// Referencing it by ?url instead would bake the server build's hash into the
// prerendered shell, which does not match the client build's hash.
import '../styles.css'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
	head: () => ({
		meta: [
			{ charSet: 'utf-8' },
			{ name: 'viewport', content: 'width=device-width, initial-scale=1' },
			{ name: 'color-scheme', content: 'dark' },
			// Pages replace this from their breadcrumb; it stands for login and setup.
			{ title: 'Vexdock' },
		],
	}),
	component: RootComponent,
})

/** Routes that render without the authenticated shell. */
const publicRoutes = new Set(['/login', '/setup'])

/** Arc renders links with an `href`; inside the app they are router links, so navigation stays client-side. */
function RouterLink({ href, ...props }: ArcLinkProps) {
	// exact: a crumb or tab is the current page only on its own URL, not under it.
	return <Link to={href} activeOptions={{ exact: true }} {...props} />
}
function RootComponent() {
	const pathname = useRouterState({ select: state => state.location.pathname })
	const isPublic = publicRoutes.has(pathname)
	const { queryClient } = Route.useRouteContext()

	return (
		<RootDocument>
			<MotionConfig reducedMotion='user'>
				<ArcProvider link={RouterLink}>
					<TooltipProvider>
						<QueryClientProvider client={queryClient}>
							<AuthGate>
								{isPublic ? (
									<Outlet />
								) : (
									<Shell>
										<Outlet />
									</Shell>
								)}
							</AuthGate>
						</QueryClientProvider>
					</TooltipProvider>
				</ArcProvider>
			</MotionConfig>
		</RootDocument>
	)
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
	return (
		// use-pointer-cursors is what the stylesheet gates pointer cursors on.
		<html lang='en' className='use-pointer-cursors'>
			<head>
				<HeadContent />
			</head>
			{/* The inline colors paint before the stylesheet arrives, so booting
          the SPA never flashes white. They are Arc's dark --background and
          --foreground, resolved to sRGB. */}
			<body style={{ background: '#141414', color: '#f1f1f1' }}>
				<div id='root'>{children}</div>
				<Scripts />
			</body>
		</html>
	)
}
