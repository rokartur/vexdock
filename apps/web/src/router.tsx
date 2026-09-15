import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

/** TanStack Start finds this file by name, so nothing imports it. */
export function getRouter() {
	return createRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreload: 'intent',
	})
}
