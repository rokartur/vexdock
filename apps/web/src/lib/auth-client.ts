import { createAuthClient } from 'better-auth/react'

/**
 * Login, sign-up and session state come from the better-auth service, which
 * Nginx serves at /api/auth on the same origin as the dashboard.
 */
export const authClient = createAuthClient({
	basePath: '/api/auth',
})

export const { signIn, signUp, signOut, useSession } = authClient

/**
 * Whether the first administrator still has to be created. Served by the auth
 * service next to its own endpoints.
 */
export async function fetchSetupStatus(): Promise<{ needs_setup: boolean }> {
	const response = await fetch('/api/auth/platform-status', { credentials: 'same-origin' })
	if (!response.ok) throw new Error('The auth service is unreachable')
	return (await response.json()) as { needs_setup: boolean }
}
