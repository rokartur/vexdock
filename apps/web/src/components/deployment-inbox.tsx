import { useEffect, useRef, useState } from 'react'
import { IconBellOff, IconBellRinging, IconRefresh, IconX } from '@tabler/icons-react'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import {
	NotificationCenter,
	type NotificationCenterProps,
	type NotificationItem,
} from '@/components/ui/notification-center'
import type { Deployment, DeploymentStatus } from '../lib/api'
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

const finished = new Set<DeploymentStatus>(['success', 'failed', 'cancelled'])

const READ_KEY = 'vexdock:deployments-read'
const DISMISSED_KEY = 'vexdock:deployments-dismissed'
const BROWSER_KEY = 'vexdock:browser-notifications'

/** Arc's notification-center over the twenty latest deployments `/api/system/info` returns. Read and dismissed are
 * this browser's own, kept in localStorage; the server has no inbox. */
export function DeploymentInbox() {
	const info = useQuery(systemInfoQuery)
	const [read, setRead] = useStoredIds(READ_KEY)
	const [dismissed, setDismissed] = useStoredIds(DISMISSED_KEY)
	const browser = useBrowserNotifications(deploymentId => setRead(deploymentId, true))
	const settled = useRef<Set<string>>(null)
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

	// After every render, as it reads this render's items; `settled` is what makes each deploy fire once.
	useEffect(() => {
		if (!info.data) return
		const next = newlySettled(settled.current, info.data.recent_deployments)
		settled.current = next.settled
		for (const item of notifications) if (next.fresh.has(item.id) && !item.read) browser?.show(item)
	})

	return (
		<NotificationCenter
			label='Deployments'
			notifications={notifications}
			onReadChange={(item, next) => {
				setRead(item.id, next)
				if (next) void browser?.close(item.id)
			}}
			onDismiss={item => {
				setDismissed(item.id, true)
				void browser?.close(item.id)
			}}
			empty={inboxEmpty(info)}
			headerAction={browser?.headerAction}
			notice={
				browser?.asking ? (
					<AskCard onTurnOn={() => browser.turnOn()} onNotNow={() => browser.turnOff()} />
				) : undefined
			}
		/>
	)
}

/** The ids of the deploys that reached a final status, and which of them did since `before`, the previous answer's.
 * The first answer (`before` null) has none fresh: what finished before the tab opened is already in the inbox. */
export function newlySettled(before: Set<string> | null, recent: { deployment: Pick<Deployment, 'id' | 'status'> }[]) {
	const settled = new Set<string>()
	for (const { deployment } of recent) if (finished.has(deployment.status)) settled.add(deployment.id)
	const fresh = new Set(before ? [...settled].filter(id => !before.has(id)) : [])
	return { settled, fresh }
}

/** The system's own notification for a deploy that ends while the dashboard is not in front, one per deploy (its id
 * is the tag), so tabs showing the same one replace each other. Undefined where the service worker never activates:
 * dev builds, and plain HTTP, where browsers refuse both the worker and notifications. */
function useBrowserNotifications(onClick: (deploymentId: string) => void) {
	const [worker, setWorker] = useState<ServiceWorkerRegistration>()
	const [choice, setChoice] = useState(() => localStorage.getItem(BROWSER_KEY))
	const clicked = useRef(onClick)
	clicked.current = onClick

	useEffect(() => {
		if (!('Notification' in window && 'serviceWorker' in navigator)) return
		void navigator.serviceWorker.ready.then(setWorker)
		const listener = ({ data }: MessageEvent) => {
			if (data?.type === 'notification-click') clicked.current(data.deploymentId)
		}
		navigator.serviceWorker.addEventListener('message', listener)
		return () => navigator.serviceWorker.removeEventListener('message', listener)
	}, [])

	if (!worker) return
	const choose = (next: 'on' | 'off') => {
		localStorage.setItem(BROWSER_KEY, next)
		setChoice(next)
	}
	const turnOn = async () => choose((await Notification.requestPermission()) === 'granted' ? 'on' : 'off')
	const turnOff = () => choose('off')
	// Read live on every render: the permission can be revoked in the site's settings at any time.
	const { permission } = Notification
	const on = choice === 'on' && permission === 'granted'

	let headerAction: NotificationCenterProps['headerAction'] = {
		icon: IconBellOff,
		label: 'Turn on browser notifications',
		onClick: turnOn,
	}
	if (on) headerAction = { icon: IconBellRinging, label: 'Turn off browser notifications', onClick: turnOff }
	if (permission === 'denied')
		headerAction = { icon: IconBellOff, label: 'Browser notifications are blocked in site settings' }

	return {
		asking: choice === null && permission !== 'denied',
		headerAction,
		turnOn,
		turnOff,
		show(item: NotificationItem) {
			if (!on || document.hasFocus()) return
			void worker.showNotification(item.title, { body: item.description, tag: item.id, icon: '/icon-192.png' })
		},
		async close(deploymentId: string) {
			for (const shown of await worker.getNotifications({ tag: deploymentId })) shown.close()
		},
	}
}

/** Asks once per browser; after Turn on or Not now the header's bell switches it. */
function AskCard({ onTurnOn, onNotNow }: { onTurnOn: () => void; onNotNow: () => void }) {
	return (
		<div className='mx-[11px] mt-[9px] flex items-center gap-3 rounded-[calc(var(--radius-panel)-6px)] border border-border-subtle bg-surface-muted p-3 max-[380px]:mx-[5px] max-[380px]:flex-wrap'>
			<p className='m-0 min-w-0 flex-1 text-xs text-secondary'>
				<strong className='block text-sm font-medium text-foreground'>Know when a deploy ends</strong>
				A browser notification while this tab is in the background.
			</p>
			<Button size='sm' onClick={onTurnOn}>
				<IconBellRinging size={16} stroke={1.75} />
				Turn on
			</Button>
			<Button size='sm' variant='ghost' onClick={onNotNow}>
				<IconX size={16} stroke={1.75} />
				Not now
			</Button>
		</div>
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
