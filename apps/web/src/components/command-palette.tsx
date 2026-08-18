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

/**
 * Jump to any page or project. Opened with Cmd/Ctrl+K, closed with Escape.
 * Filtering, keyboard navigation and focus handling come from shadcn's Command.
 */
export function CommandPalette({
	links,
	open,
	onOpenChange,
}: {
	links: { to: string; label: string }[]
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
									{project.name}
									<span className='ml-auto font-mono text-meta text-muted-foreground'>
										{project.running_count}/{project.service_count}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					) : null}
				</CommandList>
			</Command>
		</CommandDialog>
	)
}
