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

	// Presence is the last thing a visitor said, so leaving has to be said out
	// loud: without this the panel keeps counting a closed tab until its events
	// age out. visibilitychange covers a backgrounded phone, pagehide a closed
	// desktop tab, and both are the events that still fire when a page dies.
	// ponytail: one hidden tab reports the whole device as gone until another
	// tab's next heartbeat.
	addEventListener('visibilitychange', () => {
		send(document.visibilityState === 'visible' ? 'ping' : 'leave')
	})
	addEventListener('pagehide', () => send('leave'))

	window.vx = (name, props) => send(String(name), props)

	pageview()
})()
