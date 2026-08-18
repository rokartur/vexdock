/** One path segment of the header trail. */
export type TrailSegment = {
	/** Raw URL segment, used to look up a nicer label (ids, project names). */
	segment: string
	/** Absolute path this segment stands for. */
	to: string
	/** False for the current page and for paths no route serves, like /docker. */
	linkable: boolean
}

/** True when a concrete path is served by a route pattern such as /projects/$projectId. */
function servedBy(pattern: string, path: string): boolean {
	const patternParts = pattern.split('/').filter(Boolean)
	const pathParts = path.split('/').filter(Boolean)
	return (
		patternParts.length === pathParts.length &&
		patternParts.every((part, index) => part.startsWith('$') || part === pathParts[index])
	)
}

/**
 * Expands a pathname into the breadcrumb trail, so pages never spell out their
 * own ancestors. `routePatterns` comes from the router; an ancestor that no
 * route serves (/docker, /deployments) still shows, it just is not a link.
 */
export function trailOf(pathname: string, routePatterns: string[]): TrailSegment[] {
	const segments = pathname.split('/').filter(Boolean)
	// The root carries no segment, but it is still a page: the dashboard.
	if (segments.length === 0) return [{ segment: 'dashboard', to: '/', linkable: false }]
	return segments.map((segment, index) => {
		const to = `/${segments.slice(0, index + 1).join('/')}`
		const isCurrentPage = index === segments.length - 1
		return {
			segment,
			to,
			linkable: !isCurrentPage && routePatterns.some(pattern => servedBy(pattern, to)),
		}
	})
}

/** Title-cases a URL segment: 'backups' -> 'Backups', 'docker-hub' -> 'Docker hub'. */
export function labelOf(segment: string): string {
	return segment.replaceAll('-', ' ').replace(/^./u, first => first.toUpperCase())
}
