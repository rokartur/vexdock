/**
 * Where a deployment is read: its project's deployments tab, with that row
 * expanded. Spread into a `Link` or handed to `navigate`.
 */
export const deploymentLink = (projectId: string, deploymentId: string) =>
	({
		to: '/projects/$projectId/deployments',
		params: { projectId },
		search: { deployment: deploymentId },
	}) as const
