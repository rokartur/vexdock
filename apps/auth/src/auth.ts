import { betterAuth } from 'better-auth'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Authentication for the whole platform.
 *
 * better-auth owns users and sessions in its own SQLite file. The Go manager
 * never issues credentials: it reads the session table to authenticate API
 * requests, which keeps exactly one implementation of login in the system.
 */

const root = process.env.PLATFORM_ROOT ?? '/opt/platform'
const databasePath = process.env.PLATFORM_AUTH_DB ?? `${root}/data/auth.db`
mkdirSync(dirname(databasePath), { recursive: true })

// WAL lets the Go manager read sessions from this file while the auth service
// writes to it.
const database = new Database(databasePath, { create: true })
database.exec('PRAGMA journal_mode = WAL')
database.exec('PRAGMA busy_timeout = 5000')

/** The dashboard origin, used for trusted origins and cookie settings. */
const publicUrl = process.env.PLATFORM_PUBLIC_URL?.replace(/\/$/, '') ?? ''

// The options are exported as well so the boot-time migration and the auth
// instance can never drift apart.
export const authOptions = {
  database,
  basePath: '/api/auth',
  baseURL: publicUrl || undefined,
  // The panel is reached by IP before a domain is attached, so the exact origin
  // is not known ahead of time. Same-origin requests are what matter here and
  // Nginx is the only thing in front.
  trustedOrigins: (request) => {
    const origin = request?.headers.get('origin')
    return origin ? [origin] : []
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
    // Set Secure only when the request actually arrived over TLS: a browser
    // discards a Secure cookie on the plain-HTTP address a fresh install uses.
    useSecureCookies: false,
    defaultCookieAttributes: {
      sameSite: 'lax',
      httpOnly: true,
    },
  },
} satisfies Parameters<typeof betterAuth>[0]

export const auth = betterAuth(authOptions)

export { database }
