import type { ReactNode } from 'react'
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRouteWithContext, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router'
import { LazyMotion, MotionConfig } from 'motion/react'
import { Toaster } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
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

// Animation features load after first paint; `m.*` components render static until they arrive.
async function loadMotionFeatures() {
	const features = await import('../lib/motion-features')
	return features.default
}

function RootComponent() {
	const pathname = useRouterState({ select: state => state.location.pathname })
	const isPublic = publicRoutes.has(pathname)
	const { queryClient } = Route.useRouteContext()

	return (
		<RootDocument>
			<LazyMotion features={loadMotionFeatures} strict>
				<MotionConfig reducedMotion='user'>
					<QueryClientProvider client={queryClient}>
						<TooltipProvider delay={300}>
							<AuthGate>
								{isPublic ? (
									<Outlet />
								) : (
									<Shell>
										<Outlet />
									</Shell>
								)}
							</AuthGate>
							<Toaster />
						</TooltipProvider>
					</QueryClientProvider>
				</MotionConfig>
			</LazyMotion>
		</RootDocument>
	)
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
	return (
		// The panel is dark only; there is no theme switch to keep in sync.
		// use-pointer-cursors is what the stylesheet gates pointer cursors on.
		<html lang='en' className='dark use-pointer-cursors'>
			<head>
				<HeadContent />
			</head>
			{/* The inline colors paint before the stylesheet arrives, so booting
          the SPA never flashes white. They are --background and --foreground
          from the bY64 palette, resolved to sRGB. */}
			<body style={{ background: '#0a0a0a', color: '#fafafa' }}>
				<div id='root'>{children}</div>
				<Scripts />
			</body>
		</html>
	)
}
