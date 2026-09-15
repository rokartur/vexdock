import { createAuthClient } from 'better-auth/react'

/** Nginx serves the auth service at /api/auth, on the same origin as the dashboard. */
const authClient = createAuthClient({
	basePath: '/api/auth',
})

export const { signIn, signUp, signOut, useSession } = authClient

/** Whether the first administrator still has to be created. */
export async function fetchSetupStatus(): Promise<{ needs_setup: boolean }> {
	const response = await fetch('/api/auth/platform-status', { credentials: 'same-origin' })
	if (!response.ok) throw new Error('The auth service is unreachable')
	return (await response.json()) as { needs_setup: boolean }
}
