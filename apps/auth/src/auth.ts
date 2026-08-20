import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { betterAuth } from 'better-auth'

/**
 * Authentication for the whole platform.
 *
 * better-auth owns users and sessions in its own SQLite file. The Go manager
 * never issues credentials: it reads the session table to authenticate API
 * requests, which keeps exactly one implementation of login in the system.
 */

const root = process.env.PLATFORM_ROOT ?? '/opt/vexdock'
const databasePath = process.env.PLATFORM_AUTH_DB ?? `${root}/data/auth.db`
mkdirSync(path.dirname(databasePath), { recursive: true })

// WAL lets the Go manager read sessions from this file while the auth service
// writes to it.
const database = new Database(databasePath, { create: true })
database.exec('PRAGMA journal_mode = WAL')
database.exec('PRAGMA busy_timeout = 5000')

/** The dashboard origin, used for trusted origins and cookie settings. */
const publicUrl = process.env.PLATFORM_PUBLIC_URL?.replace(/\/$/u, '') ?? ''

// Signs every session cookie. There is no fallback on purpose: a shared default
// would let anyone mint a valid session for every install of the platform.
const secret = process.env.BETTER_AUTH_SECRET
if (!secret) throw new Error('BETTER_AUTH_SECRET is required')

// The options are exported as well so the boot-time migration and the auth
// instance can never drift apart.
export const authOptions = {
	database,
	secret,
	basePath: '/api/auth',
	baseURL: publicUrl || undefined,
	// The panel is reached by IP before a domain is attached, so the exact origin
	// is not known ahead of time. The host the browser asked for is, and matching
	// the origin against it is the same-origin check: a request forged from
	// another site fails it. Echoing the caller's own Origin back would trust
	// every origin, which is the same as no check at all.
	trustedOrigins: request => {
		const host = request?.headers.get('host')
		const origins = publicUrl ? [publicUrl] : []
		if (host) origins.push(`http://${host}`, `https://${host}`)
		return origins
	},
	emailAndPassword: {
		enabled: true,
		// Single-tenant platform: there is no inbox to verify against.
		requireEmailVerification: false,
		minPasswordLength: 10,
		autoSignIn: true,
	},
	session: {
		expiresIn: 60 * 60 * 24 * 14,
		updateAge: 60 * 60 * 24,
	},
	// better-auth only rate limits in production by default, and the panel does
	// not set NODE_ENV, so it is enabled explicitly. Nginx throttles the same
	// endpoints as a second layer.
	rateLimit: {
		enabled: true,
		window: 60,
		max: 60,
		customRules: {
			'/sign-in/email': { window: 60, max: 5 },
			'/sign-up/email': { window: 60, max: 5 },
		},
	},
	advanced: {
		// Secure follows PLATFORM_PUBLIC_URL: a browser discards a Secure cookie on
		// the plain-HTTP address a fresh install uses, so it can only be set once
		// the operator has declared an HTTPS origin for the panel.
		useSecureCookies: publicUrl.startsWith('https://'),
		defaultCookieAttributes: {
			sameSite: 'lax',
			httpOnly: true,
		},
	},
} satisfies Parameters<typeof betterAuth>[0]

export const auth = betterAuth(authOptions)

export { database }
