import { IconFolder, type Icon as TablerIcon } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from '@/components/ui/command'
import { api } from '../lib/api'
import { Keys } from './primitives'

/**
 * Jump to any page or project. Opened with Cmd/Ctrl+K, closed with Escape.
 * Filtering, keyboard navigation and focus handling come from shadcn's Command.
 */
export function CommandPalette({
	links,
	open,
	onOpenChange,
}: {
	links: { to: string; label: string; icon: TablerIcon }[]
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const navigate = useNavigate()
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, staleTime: 30_000, enabled: open })

	const go = (to: string) => {
		onOpenChange(false)
		void navigate({ to })
	}

	return (
		<CommandDialog open={open} onOpenChange={onOpenChange} title='Jump to' description='Pages and projects'>
			{/* CommandDialog only supplies the dialog; the cmdk store that the input
          and list subscribe to comes from Command. */}
			<Command>
				<CommandInput placeholder='Jump to…' />
				<CommandList>
					<CommandEmpty>No matches</CommandEmpty>
					<CommandGroup heading='Pages'>
						{links.map(link => (
							<CommandItem key={link.to} value={`${link.label} ${link.to}`} onSelect={() => go(link.to)}>
								<link.icon />
								{link.label}
							</CommandItem>
						))}
					</CommandGroup>
					{projects.data?.length ? (
						<CommandGroup heading='Projects'>
							{projects.data.map(project => (
								<CommandItem
									key={project.id}
									value={`${project.name} ${project.slug}`}
									onSelect={() => go(`/projects/${project.id}`)}
								>
									<IconFolder />
									{project.name}
									<span className='ml-auto font-mono text-meta text-muted-foreground'>
										{project.running_count}/{project.service_count}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					) : null}
				</CommandList>
				{/* Negative margins undo Command's padding so the hairline spans the dialog. */}
				<div className='-mx-1 -mb-1 flex items-center gap-3 border-t border-rule px-4 py-1.5 text-meta text-muted-foreground'>
					<span className='flex items-center gap-1'>
						<Keys keys={['↑', '↓']} />
						move
					</span>
					<span className='flex items-center gap-1'>
						<Keys keys={['↵']} />
						open
					</span>
					<span className='ml-auto flex items-center gap-1'>
						<Keys keys={['Esc']} />
						close
					</span>
				</div>
			</Command>
		</CommandDialog>
	)
}
