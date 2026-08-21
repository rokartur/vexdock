// Served as /_vx.js from the site's own domain and injected by the generated
// vhost, so nothing has to change inside the deployed app.
;(() => {
	const endpoint = '/_vx'
	let lastPath = null

	let timezone = ''
	try {
		timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
	} catch {
		timezone = ''
	}

	const send = (kind, props) => {
		const body = JSON.stringify({
			k: kind,
			p: location.pathname,
			r: document.referrer,
			tz: timezone,
			props: props || null,
		})
		if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body)
		else fetch(endpoint, { method: 'POST', body, keepalive: true })
	}

	// A single-page app replaces the URL without a load event, and some routers
	// replaceState on every render, so repeats of the current path are ignored.
	const pageview = () => {
		if (location.pathname === lastPath) return
		lastPath = location.pathname
		send('pageview')
	}

	const wrap = name => {
		const original = history[name]
		history[name] = function tracked(...args) {
			original.apply(this, args)
			pageview()
		}
	}
	wrap('pushState')
	wrap('replaceState')
	addEventListener('popstate', pageview)

	// Visit duration is derived from these: a reader with one tab open still
	// reports a heartbeat every minute.
	setInterval(() => {
		if (document.visibilityState === 'visible') send('ping')
	}, 60_000)

	window.vx = (name, props) => send(String(name), props)

	pageview()
})()
