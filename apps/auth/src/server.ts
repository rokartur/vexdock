import { getMigrations } from 'better-auth/db/migration'
import { auth, authOptions, database } from './auth'

/**
 * Auth service. Nginx routes /api/auth/* here; everything else goes to the Go
 * manager. Only the first account may be created: the platform is single
 * tenant, so sign-up closes as soon as an administrator exists.
 */

const port = Number(process.env.PORT ?? 8081)

// The schema is applied on boot, the same way the Go manager migrates its own
// database, so a fresh install needs no separate migration step.
const { runMigrations } = await getMigrations(authOptions)
await runMigrations()

const countUsers = database.query('SELECT COUNT(*) AS n FROM user')

function userCount(): number {
	return (countUsers.get() as { n: number }).n
}

const server = Bun.serve({
	port,
	hostname: '0.0.0.0',
	idleTimeout: 30,

	fetch(request) {
		// URL.parse returns null instead of throwing on a malformed request line.
		const url = URL.parse(request.url)
		if (!url) return new Response('Bad Request', { status: 400 })

		if (url.pathname === '/health') {
			return Response.json({ status: 'healthy', users: userCount() })
		}

		// The dashboard asks whether to show the setup wizard or the login form.
		if (url.pathname === '/api/auth/platform-status') {
			return Response.json({ needs_setup: userCount() === 0 })
		}

		if (url.pathname === '/api/auth/sign-up/email' && userCount() > 0) {
			return Response.json(
				{ error: { code: 'SETUP_CLOSED', message: 'An administrator already exists' } },
				{ status: 409 },
			)
		}

		return auth.handler(request)
	},
})

console.log(JSON.stringify({ level: 'info', msg: 'auth service listening', port: server.port }))
