// Served as /_vx/script.js from the site's own hostname. Add
// <script defer src="/_vx/script.js"></script> to the page; window.vx('signup')
// records a goal. The vx_vid cookie is the visitor id a backend sends with a
// payment so its revenue lands on the channel that brought the visitor.
// oxlint-disable unicorn/consistent-function-scoping, unicorn/no-document-cookie -- a classic script on someone
// else's page: the IIFE keeps names off its global scope, and Firefox and Safari lack the Cookie Store API.
;(() => {
	const endpoint = '/_vx/event'
	const secure = location.protocol === 'https:' ? '; Secure' : ''
	let lastPath = null

	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''

	const read = name => {
		const entry = document.cookie.split('; ').find(c => c.startsWith(`${name}=`))
		return entry ? entry.slice(name.length + 1) : ''
	}
	// crypto.randomUUID exists only in secure contexts, so plain HTTP gets the fallback.
	const fresh = () =>
		crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12)
	// The session cookie is rewritten on every event, so it lapses after thirty idle minutes.
	const keep = (name, maxAge) => {
		const value = read(name) || fresh()
		document.cookie = `${name}=${value}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`
		return value
	}

	const send = (kind, name) => {
		const query = new URLSearchParams(location.search)
		const body = JSON.stringify({
			kind,
			name: name || '',
			visitor: keep('vx_vid', 31_536_000),
			session: keep('vx_sid', 1800),
			path: location.pathname,
			referrer: document.referrer,
			utm_source: query.get('utm_source') || query.get('ref') || '',
			utm_medium: query.get('utm_medium') || '',
			utm_campaign: query.get('utm_campaign') || '',
			timezone,
		})
		if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body)
		else fetch(endpoint, { method: 'POST', body, keepalive: true })
	}

	// A single-page app changes the URL without a load, and some routers
	// replaceState on every render, so a repeat of the current path is ignored.
	const pageview = () => {
		if (location.pathname === lastPath) return
		lastPath = location.pathname
		send('pageview')
	}
	for (const method of ['pushState', 'replaceState']) {
		const original = history[method]
		history[method] = function tracked(...args) {
			original.apply(this, args)
			pageview()
		}
	}
	addEventListener('popstate', pageview)

	// Session length and the online count come from this heartbeat.
	setInterval(() => {
		if (document.visibilityState === 'visible') send('ping')
	}, 60_000)

	window.vx = name => send('goal', String(name))

	pageview()
})()
