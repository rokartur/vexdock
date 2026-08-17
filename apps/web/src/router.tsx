import { createRouter } from '@tanstack/react-router'

import { routeTree } from './routeTree.gen'

/** Router factory used by the SPA entry. */
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
  })
}
