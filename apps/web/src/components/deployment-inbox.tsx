import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NotificationCenter, type NotificationItem } from '@/components/ui/notification-center'
import type { DeploymentStatus } from '../lib/api'
import { since } from '../lib/format'
import { systemInfoQuery } from '../lib/queries'

const tones: Record<DeploymentStatus, NotificationItem['tone']> = {
	queued: 'info',
	running: 'info',
	success: 'success',
	failed: 'warning',
	cancelled: 'warning',
}

const READ_KEY = 'vexdock:deployments-read'
const DISMISSED_KEY = 'vexdock:deployments-dismissed'

/** Arc's notification-center over the twenty latest deployments `/api/system/info` returns. Read and dismissed are
 * this browser's own, kept in localStorage; the server has no inbox. */
export function DeploymentInbox() {
	const info = useQuery(systemInfoQuery)
	const [read, setRead] = useStoredIds(READ_KEY)
	const [dismissed, setDismissed] = useStoredIds(DISMISSED_KEY)

	const notifications = useMemo(() => {
		const items: NotificationItem[] = []
		for (const { deployment, project_name, environment_name } of info.data?.recent_deployments ?? []) {
			if (dismissed.has(deployment.id)) continue
			const subject = deployment.service_name || project_name
			items.push({
				id: deployment.id,
				title: `${subject} deploy #${deployment.number} ${deployment.status}`,
				description: [`${project_name} / ${environment_name}`, deployment.error].filter(Boolean).join('. '),
				time: since(deployment.finished_at || deployment.created_at),
				tone: tones[deployment.status],
				read: read.has(deployment.id),
			})
		}
		return items
	}, [info.data, read, dismissed])

	return (
		<NotificationCenter
			label='Deployments'
			notifications={notifications}
			onReadChange={(item, next) => setRead(item.id, next)}
			onDismiss={item => setDismissed(item.id, true)}
		/>
	)
}

function useStoredIds(key: string) {
	const [ids, setIds] = useState(() => new Set<string>(JSON.parse(localStorage.getItem(key) ?? '[]')))
	const write = (id: string, on: boolean) =>
		setIds(current => {
			const next = new Set(current)
			if (on) next.add(id)
			else next.delete(id)
			// The API lists only the latest twenty, so keeping the newest 100 ids loses nothing that can return.
			localStorage.setItem(key, JSON.stringify([...next].slice(-100)))
			return next
		})
	return [ids, write] as const
}
