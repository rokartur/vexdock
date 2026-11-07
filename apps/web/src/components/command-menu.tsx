import { useEffect } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { IconFolder, IconRefresh, type Icon as TablerIcon } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CommandPalette, type CommandItem } from '@/components/ui/command-palette'
import { projectsQuery } from '../lib/queries'

// Not routes: ids of the Projects group's own status rows.
const LOADING = 'projects:loading'
const RETRY = 'projects:retry'

/** Arc's command-palette in a dialog on Cmd/Ctrl+K: every sidebar destination, then every project. The sidebar's
 * search row opens it too, so the caller owns `open`. */
export function CommandMenu({
	groups,
	open,
	onOpenChange: setOpen,
}: {
	groups: { label: string; pages: { to: string; label: string; icon: TablerIcon }[] }[]
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const navigate = useNavigate()
	const projects = useQuery({ ...projectsQuery, enabled: open })

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
			// Another modal owns the keyboard: opening over it would leave its form behind unasked.
			const { target } = event
			if (!open && target instanceof Element && target.closest('[role=dialog],[role=alertdialog]')) return
			event.preventDefault()
			setOpen(!open)
		}
		document.addEventListener('keydown', onKey)
		return () => document.removeEventListener('keydown', onKey)
	}, [open, setOpen])

	const items: CommandItem[] = groups.flatMap(group =>
		group.pages.map(page => ({
			id: page.to,
			label: page.label,
			group: group.label,
			icon: <page.icon size={16} stroke={1.75} />,
		})),
	)
	for (const project of projects.data ?? []) {
		items.push({
			id: `/projects/${project.id}`,
			label: project.name,
			description: `${project.service_count} service${project.service_count === 1 ? '' : 's'}`,
			group: 'Projects',
			keywords: project.tags,
			icon: <IconFolder size={16} stroke={1.75} />,
		})
	}
	// The Projects group says why it is empty, so a typed project name does not read as "no such project".
	// A retry keeps `isError` until it answers, so a refetch after an error reads as loading.
	const retrying = projects.isError && projects.isFetching
	if (projects.isPending || retrying) {
		items.push({
			id: LOADING,
			label: 'Loading projects',
			group: 'Projects',
			pinned: true,
			icon: <IconFolder size={16} stroke={1.75} />,
		})
	}
	if (projects.isError && !retrying) {
		items.push({
			id: RETRY,
			label: 'Could not load projects',
			description: 'Select to try again',
			group: 'Projects',
			pinned: true,
			icon: <IconRefresh size={16} stroke={1.75} />,
		})
	}

	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Portal>
				<Dialog.Backdrop className='fixed inset-0 z-50 bg-background/46 scrim backdrop-blur-[7px]' />
				<Dialog.Popup
					aria-label='Command palette'
					className='fixed top-[min(20vh,160px)] left-1/2 z-50 w-[min(calc(100%-24px),560px)] -translate-x-1/2 transition-[opacity,scale] duration-170 ease-enter data-ending-style:scale-97 data-ending-style:opacity-0 data-ending-style:duration-125 data-ending-style:ease-exit data-starting-style:scale-97 data-starting-style:opacity-0'
				>
					<CommandPalette
						autoFocus
						items={items}
						placeholder='Jump to a page or project'
						onClose={() => setOpen(false)}
						onSelect={item => {
							if (item.id === LOADING) return
							if (item.id === RETRY) {
								void projects.refetch()
								return
							}
							setOpen(false)
							// The palette's exit is the motion; a page swap would freeze it in the snapshot. The env id in the URL
							// belongs to the project being left, and another project's routes 404 it.
							void navigate({ to: item.id, search: { env: undefined }, viewTransition: false })
						}}
					/>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
