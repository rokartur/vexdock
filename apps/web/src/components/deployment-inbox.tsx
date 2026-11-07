import { useEffect, useState } from 'react'
import { IconRefresh } from '@tabler/icons-react'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { NotificationCenter, type NotificationItem } from '@/components/ui/notification-center'
import type { DeploymentStatus } from '../lib/api'
import { since } from '../lib/format'
import { systemInfoQuery } from '../lib/queries'
import { Button } from './primitives'

const outcomes: Record<DeploymentStatus, { tone: NotificationItem['tone']; word: string }> = {
	queued: { tone: 'info', word: 'queued' },
	running: { tone: 'info', word: 'running' },
	success: { tone: 'success', word: 'succeeded' },
	failed: { tone: 'danger', word: 'failed' },
	cancelled: { tone: 'warning', word: 'canceled' },
}

const READ_KEY = 'vexdock:deployments-read'
const DISMISSED_KEY = 'vexdock:deployments-dismissed'

/** Arc's notification-center over the twenty latest deployments `/api/system/info` returns. Read and dismissed are
 * this browser's own, kept in localStorage; the server has no inbox. */
export function DeploymentInbox() {
	const info = useQuery(systemInfoQuery)
	const [read, setRead] = useStoredIds(READ_KEY)
	const [dismissed, setDismissed] = useStoredIds(DISMISSED_KEY)
	const [, redraw] = useState(0)

	const notifications: NotificationItem[] = []
	let newest = 0
	for (const { deployment, project_name, environment_name } of info.data?.recent_deployments ?? []) {
		if (dismissed.has(deployment.id)) continue
		const subject = deployment.service_name || project_name
		const stamp = deployment.finished_at || deployment.created_at
		const at = Date.parse(stamp)
		const outcome = outcomes[deployment.status]
		newest = Math.max(newest, at)
		notifications.push({
			id: deployment.id,
			title: `${subject} deploy #${deployment.number} ${outcome.word}`,
			// A cancel writes `cancelled` into error too, which the title already says.
			description: [`${project_name} / ${environment_name}`, deployment.status === 'failed' && deployment.error]
				.filter(Boolean)
				.join('. '),
			time: since(stamp),
			// The API's RFC3339 carries up to nine fraction digits; HTML's datetime takes three.
			dateTime: new Date(at).toISOString(),
			tone: outcome.tone,
			read: read.has(deployment.id),
		})
	}

	// Arc's item takes its time as text, so the list redraws for each `since()` to move on, at RelativeTime's pace:
	// every second while the newest stamp is under a minute old, every 30 s after.
	const tickMs = Date.now() - newest < 60_000 ? 1000 : 30_000
	const empty = notifications.length === 0
	useEffect(() => {
		if (empty) return
		const timer = setInterval(() => redraw(count => count + 1), tickMs)
		return () => clearInterval(timer)
	}, [empty, tickMs])
	return (
		<NotificationCenter
			label='Deployments'
			notifications={notifications}
			onReadChange={(item, next) => setRead(item.id, next)}
			onDismiss={item => setDismissed(item.id, true)}
			empty={inboxEmpty(info)}
		/>
	)
}

/** What the empty panel says while the deployments are not known: a skeleton would sit under an all-clear otherwise. */
function inboxEmpty(info: UseQueryResult) {
	if (info.isPending) return { title: 'Loading deployments', description: 'The latest twenty show up here.' }
	// A failed refetch keeps the last list, which still reads true, so only a list never loaded is replaced.
	if (!info.isError || info.data) return
	return {
		title: 'Could not load deployments',
		description: info.error.message,
		action: (
			<Button variant='ghost' loading={info.isFetching} onClick={() => info.refetch()}>
				<IconRefresh size={16} stroke={1.75} />
				Try again
			</Button>
		),
	}
}

function useStoredIds(key: string) {
	const [ids, setIds] = useState(() => readIds(key))
	// Mark all read calls this once per item in one loop, so each call starts from storage, not from this render.
	const write = (id: string, on: boolean) => {
		const next = readIds(key)
		if (on) next.add(id)
		else next.delete(id)
		// The API lists only the latest twenty, so keeping the newest 100 ids loses nothing that can return.
		localStorage.setItem(key, JSON.stringify([...next].slice(-100)))
		setIds(next)
	}
	return [ids, write] as const
}

function readIds(key: string) {
	try {
		return new Set<string>(JSON.parse(localStorage.getItem(key) ?? '[]'))
	} catch {
		// A value this code did not write must not take the header down on every page; the next write replaces it.
		return new Set<string>()
	}
}
