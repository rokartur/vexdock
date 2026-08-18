import { useEffect, useState, type ReactNode } from 'react'
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

	const setup = useQuery({ queryKey: ['auth', 'setup'], queryFn: fetchSetupStatus, retry: false })
	const session = useSession()
	const phase = useBootScreenPhase()

	const needsSetup = setup.data?.needs_setup === true
	const authenticated = Boolean(session.data?.user)
	const resolved = setup.data !== undefined && !session.isPending

	useEffect(() => {
		if (!resolved) return
		if (needsSetup && pathname !== '/setup') {
			void navigate({ to: '/setup', replace: true })
			return
		}
		if (!needsSetup && !authenticated && pathname !== '/login') {
			void navigate({ to: '/login', replace: true })
			return
		}
		if (authenticated && (pathname === '/login' || pathname === '/setup')) {
			void navigate({ to: '/', replace: true })
		}
	}, [resolved, needsSetup, authenticated, pathname, navigate])

	if (!resolved) {
		// A failed status query never fills `setup.data`, so both the error and the
		// silent-for-too-long case have to be answered from inside the unresolved
		// branch or the gate would sit on "connecting" forever.
		if (setup.isError || phase === 'stalled') return <BootScreen stalled />
		return phase === 'hidden' ? null : <BootScreen />
	}

	// Hold the route back while the redirect above is in flight. Rendering the
	// authenticated shell first would mount every dashboard query and fire a
	// burst of requests that can only answer 401.
	const target = needsSetup ? '/setup' : authenticated ? null : '/login'
	if (target && target !== pathname) return null

	return children
}

/**
 * A healthy manager answers in well under a second, so the boot screen stays
 * hidden at first and only appears once the wait is long enough to notice.
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

function BootScreen({ stalled = false }: { stalled?: boolean }) {
	return (
		<div className='flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center'>
			<p className='text-sm'>{stalled ? 'The manager is not responding' : 'Connecting to the manager'}</p>
			{stalled ? (
				<Button
					onClick={() => {
						window.location.reload()
					}}
				>
					Retry
				</Button>
			) : null}
		</div>
	)
}
