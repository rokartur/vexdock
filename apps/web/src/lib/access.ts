import type { ProjectGrant } from './api'

export type Level = ProjectGrant['level']

/** What a token or an OAuth grant may reach, as the access picker holds it. */
export type Access = { full: boolean; grants: Record<string, Level> }

export const noAccess: Access = { full: false, grants: {} }

/** The list the API takes. An empty one means full access, so an empty selection must never reach it. */
export function grantList(access: Access): ProjectGrant[] {
	return Object.entries(access.grants).map(([project_id, level]) => ({ project_id, level }))
}

export function picksNothing(access: Access) {
	return !access.full && Object.keys(access.grants).length === 0
}

/** Reads a choice back as one sentence for the consent screen; empty while nothing is picked. */
export function accessSummary(client: string, access: Access, projectName: (id: string) => string) {
	if (access.full)
		return `${client} will reach everything: every project, Docker, the server's settings and its tokens.`
	const write: string[] = []
	const read: string[] = []
	for (const [id, level] of Object.entries(access.grants)) {
		;(level === 'write' ? write : read).push(projectName(id))
	}
	const reaches: string[] = []
	if (write.length > 0) reaches.push(`deploy, exec and change variables in ${listed.format(write)}`)
	if (read.length > 0) reaches.push(`read ${listed.format(read)}`)
	if (reaches.length === 0) return ''
	return `${client} will ${reaches.join(' and ')}. It cannot see other projects or the server.`
}

const listed = new Intl.ListFormat('en', { type: 'conjunction' })
