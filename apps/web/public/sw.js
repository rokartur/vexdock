// Keeps the last app shell and the hashed assets it loaded, so an installed dashboard still opens without a network.
// Nothing under /api is cached: every reading on the dashboard is live, and some responses carry secrets.
const SHELL_CACHE = 'vexdock-shell'
const ASSETS_CACHE = 'vexdock-assets'
const SHELL = '/index.html'

// A new release renames its assets. Keeping only what the new shell names is enough to boot offline; pages
// visited online cache their own chunks again.
const keepAssetsOf = async shell => {
	const named = new Set(shell.match(/\/assets\/[^"']+/gu))
	const assets = await caches.open(ASSETS_CACHE)
	const requests = await assets.keys()
	const stale = requests.filter(request => !named.has(new URL(request.url).pathname))
	await Promise.all(stale.map(request => assets.delete(request)))
}

const saveShell = async response => {
	const cache = await caches.open(SHELL_CACHE)
	const previous = await cache.match(SHELL)
	const shell = await response.clone().text()
	const changed = !previous || (await previous.text()) !== shell
	await cache.put(SHELL, response)
	if (changed) await keepAssetsOf(shell)
}

// Network first, so a manager update reaches the next page load; the cache only answers when the server cannot.
const shellFromNetwork = async event => {
	let response
	try {
		response = await fetch(event.request)
	} catch {
		return (await caches.match(SHELL)) ?? Response.error()
	}
	if (response.ok && response.headers.get('content-type')?.startsWith('text/html')) {
		event.waitUntil(saveShell(response.clone()))
	}
	return response
}

// Asset names carry a content hash, so a cached copy is never stale.
const assetFromCache = async event => {
	const assets = await caches.open(ASSETS_CACHE)
	const cached = await assets.match(event.request)
	if (cached) return cached
	const response = await fetch(event.request)
	if (response.ok) event.waitUntil(assets.put(event.request, response.clone()))
	return response
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

// The tag is the deployment id: every open tab hears the click and marks it read, the last focused comes forward.
// shortcut: with no tab open it stays unread, a worker has no localStorage; put the id in the URL if that matters.
const openFromNotification = async deploymentId => {
	const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
	// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Client.postMessage's second argument is the transfer list
	for (const client of windows) client.postMessage({ type: 'notification-click', deploymentId })
	if (windows[0]) return windows[0].focus()
	return self.clients.openWindow('/')
}

self.addEventListener('notificationclick', event => {
	event.notification.close()
	event.waitUntil(openFromNotification(event.notification.tag))
})

self.addEventListener('fetch', event => {
	const { request } = event
	const url = new URL(request.url)
	if (url.origin !== self.location.origin || request.method !== 'GET') return
	if (url.pathname.startsWith('/assets/')) {
		event.respondWith(assetFromCache(event))
		return
	}
	if (request.mode !== 'navigate') return
	if (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.startsWith('/.well-known/')) return
	event.respondWith(shellFromNetwork(event))
})
