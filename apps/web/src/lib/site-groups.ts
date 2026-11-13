import type { AnalyticsSite } from './api'

export type SiteRow = AnalyticsSite & { subdomains?: SiteRow[] }

/** Files each site under the shortest other listed hostname it is a subdomain of (`agent.rokartur.com` under
 * `rokartur.com`); a parent row carries its group's summed visitors and hourly series. */
export function groupSites(sites: AnalyticsSite[]): SiteRow[] {
	const hostnames = new Set(sites.map(site => site.domain.hostname))
	const roots = new Map<string, SiteRow>()
	for (const site of sites) {
		const { hostname } = site.domain
		if (rootOf(hostname, hostnames) === hostname) roots.set(hostname, { ...site })
	}
	for (const site of sites) {
		const root = roots.get(rootOf(site.domain.hostname, hostnames))
		if (root === undefined || root.domain.id === site.domain.id) continue
		root.subdomains = [...(root.subdomains ?? []), site]
		root.visitors += site.visitors
		root.hourly = root.hourly.map((count, hour) => count + (site.hourly[hour] ?? 0))
	}
	return [...roots.values()]
}

function rootOf(hostname: string, hostnames: Set<string>) {
	let root = hostname
	for (let dot = hostname.indexOf('.'); dot !== -1; dot = hostname.indexOf('.', dot + 1)) {
		if (hostnames.has(hostname.slice(dot + 1))) root = hostname.slice(dot + 1)
	}
	return root
}
