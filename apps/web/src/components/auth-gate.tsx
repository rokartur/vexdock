import { useEffect, useState, type ReactNode } from 'react'
import { IconAlertCircle, IconProgress, IconRefresh } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { fetchSetupStatus, useSession } from '../lib/auth-client'
import { Button } from './primitives'

/**
 * Routes the visitor to setup, login or the app. Every authenticated page can
 * therefore assume a session exists.
 */
export function AuthGate({ children }: { children: ReactNode }) {
	const navigate = useNavigate()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const searchStr = useRouterState({ select: state => state.location.searchStr })
	const next = useRouterState({ select: state => safeNext((state.location.search as { next?: unknown }).next) })
	// Holding back until the first route's loaders settle paints the shell and the page in one frame.
	const routeLoaded = useRouterState({ select: state => state.resolvedLocation !== undefined })

	const setup = useQuery({ queryKey: ['auth', 'setup'], queryFn: fetchSetupStatus, retry: false })
	const session = useSession()
	const phase = useBootScreenPhase()

	const needsSetup = setup.data?.needs_setup === true
	const authenticated = Boolean(session.data?.user)
	const resolved = setup.data !== undefined && !session.isPending
	// A shared analytics report is read without an account.
	const open = pathname.startsWith('/shared/')

	useEffect(() => {
		if (!resolved) return
		if (needsSetup && pathname !== '/setup') {
			void navigate({ to: '/setup', replace: true })
			return
		}
		if (!needsSetup && !authenticated && !open && pathname !== '/login') {
			// A deep link, such as an MCP client's consent request, survives signing in.
			void navigate({
				to: '/login',
				search: { next: pathname === '/' ? undefined : pathname + searchStr },
				replace: true,
			})
			return
		}
		if (authenticated && (pathname === '/login' || pathname === '/setup')) {
			void navigate({ href: next ?? '/', replace: true })
		}
	}, [resolved, needsSetup, authenticated, open, pathname, searchStr, next, navigate])

	if (!resolved || !routeLoaded) {
		// A failed status query never fills `setup.data`, so both the error and the
		// silent-for-too-long case have to be answered from inside the unresolved
		// branch or the gate would sit on "connecting" forever.
		return <BootScreen phase={setup.isError ? 'stalled' : phase} />
	}

	// Hold the route back while the redirect above is in flight. Rendering the
	// authenticated shell first would mount every dashboard query and fire a
	// burst of requests that can only answer 401.
	const target = needsSetup ? '/setup' : authenticated || open ? null : '/login'
	if (target && target !== pathname) return null

	return children
}

/**
 * Where to go once signed in: only a path on this origin, never `//host` or `/\host`, so a link cannot send a fresh
 * session elsewhere.
 */
export function safeNext(value: unknown) {
	return typeof value === 'string' && /^\/(?![/\\])/u.test(value) ? value : undefined
}

/**
 * A healthy manager answers in well under a second, so the boot screen only appears once the wait is worth showing.
 * Silence past eight seconds is reported as a fault instead of waited out.
 */
function useBootScreenPhase() {
	const [phase, setPhase] = useState<'hidden' | 'waiting' | 'stalled'>('hidden')

	useEffect(() => {
		const show = setTimeout(() => setPhase('waiting'), 600)
		const stall = setTimeout(() => setPhase('stalled'), 8000)
		return () => {
			clearTimeout(show)
			clearTimeout(stall)
		}
	}, [])

	return phase
}

function BootScreen({ phase }: { phase: ReturnType<typeof useBootScreenPhase> }) {
	const stalled = phase === 'stalled'
	// An installed dashboard opens from its cached shell without a network.
	const stall = navigator.onLine ? 'The manager is not responding' : 'You are offline'
	// A static glyph: a spinner repaints for the whole boot wait, and a still one reads as frozen.
	let glyph = <IconProgress stroke={1.75} className='size-5 text-muted' />
	if (stalled) glyph = <IconAlertCircle stroke={1.75} className='size-5 text-muted' />
	// Both lines are mounted empty: a live region that mounts already full is not announced. The wait is polite, the
	// stall an alert, and a region that changes its role mid-way is not reliably read.
	return (
		<main className='flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center'>
			{phase === 'hidden' ? null : glyph}
			<div className='text-sm text-muted'>
				<p role='status'>{phase === 'waiting' ? 'Connecting to the manager' : null}</p>
				<p role='alert'>{stalled ? stall : null}</p>
			</div>
			{stalled ? (
				<Button
					onClick={() => {
						window.location.reload()
					}}
				>
					<IconRefresh size={16} stroke={1.75} />
					Try again
				</Button>
			) : null}
		</main>
	)
}
