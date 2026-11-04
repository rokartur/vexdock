import { useEffect } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { IconFolder, type Icon as TablerIcon } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CommandPalette, type CommandItem } from '@/components/ui/command-palette'
import { projectsQuery } from '../lib/queries'

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
			description: `${project.service_count} services`,
			group: 'Projects',
			keywords: project.tags,
			icon: <IconFolder size={16} stroke={1.75} />,
		})
	}

	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Portal>
				<Dialog.Backdrop className='fixed inset-0 z-50 bg-background/46 backdrop-blur-[7px] transition-opacity duration-170 ease-standard data-ending-style:opacity-0 data-starting-style:opacity-0' />
				<Dialog.Popup
					aria-label='Command palette'
					className='fixed top-[min(20vh,160px)] left-1/2 z-50 w-[min(calc(100vw-24px),560px)] -translate-x-1/2 transition-[opacity,scale] duration-170 ease-enter data-ending-style:scale-97 data-ending-style:opacity-0 data-starting-style:scale-97 data-starting-style:opacity-0'
				>
					<CommandPalette
						autoFocus
						items={items}
						placeholder='Jump to a page or project'
						onClose={() => setOpen(false)}
						onSelect={item => {
							setOpen(false)
							void navigate({ to: item.id })
						}}
					/>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
