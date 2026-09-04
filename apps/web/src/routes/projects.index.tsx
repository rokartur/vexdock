import { useState } from 'react'
import { IconArrowRight, IconFolder, IconPlus, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, ErrorText, Field, IconButton, Input, Page, Refresh, Section, Status } from '../components/primitives'
import { api, type Project } from '../lib/api'
import { since } from '../lib/format'

const projectTableColumns: Columns<Project> = (() => {
	const cell = columnsFor<Project>()
	return [
		cell.accessor(project => project.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<Link
					to='/projects/$projectId'
					params={{ projectId: row.original.id }}
					className='inline-flex items-center gap-2 font-medium underline-offset-4 hover:underline'
				>
					<IconFolder className='size-4 text-muted-foreground' />
					{row.original.name}
				</Link>
			),
		}),
		cell.accessor(project => tagsOf(project).join(' '), {
			id: 'tags',
			header: 'Tags',
			cell: ({ row }) => {
				const tags = tagsOf(row.original)
				if (tags.length === 0) return <span className='text-muted-foreground'>-</span>
				return (
					<span className='flex flex-wrap gap-1'>
						{tags.map(tag => (
							<Badge key={tag} variant='outline'>
								{tag}
							</Badge>
						))}
					</span>
				)
			},
		}),
		cell.accessor(project => project.running_count, {
			id: 'services',
			header: 'Services',
			meta: { mono: true },
			cell: ({ row: { original } }) => `${original.running_count}/${original.service_count}`,
		}),
		cell.accessor(project => project.domains.length, {
			id: 'domains',
			header: 'Domains',
			meta: { mono: true },
			cell: ({ row }) => row.original.domains.length || '-',
		}),
		cell.accessor(project => project.latest_deployment?.created_at ?? '', {
			id: 'last-deploy',
			header: 'Last deploy',
			cell: ({ row: { original } }) =>
				original.latest_deployment ? (
					<span className='flex items-center gap-2'>
						<Status value={original.latest_deployment.status} />
						<span className='text-muted-foreground'>{since(original.latest_deployment.created_at)}</span>
					</span>
				) : (
					<span className='text-muted-foreground'>never</span>
				),
		}),
		cell.display({
			id: 'open',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<IconButton
					icon={IconArrowRight}
					label='Open'
					render={<Link to='/projects/$projectId' params={{ projectId: row.original.id }} />}
				/>
			),
		}),
	]
})()

export const Route = createFileRoute('/projects/')({ component: ProjectsPage })

function ProjectsPage() {
	const [creating, setCreating] = useState(false)
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

	const data = projects.data ?? []
	const knownTags = [...new Set(data.flatMap(tagsOf))]

	return (
		<Page
			actions={
				<Button variant='primary' onClick={() => setCreating(true)}>
					<IconPlus />
					New project
				</Button>
			}
		>
			<Dialog open={creating} onOpenChange={setCreating}>
				<DialogContent className='sm:max-w-lg'>
					<DialogHeader>
						<DialogTitle>New project</DialogTitle>
					</DialogHeader>
					<NewProjectForm knownTags={knownTags} onDone={() => setCreating(false)} />
				</DialogContent>
			</Dialog>

			<Section
				title='All projects'
				description={`${data.length} total`}
				actions={<Refresh onClick={() => projects.refetch()} busy={projects.isFetching} />}
			>
				<DataTable
					data={data}
					columns={projectTableColumns}
					loading={projects.isLoading}
					getRowId={project => project.id}
					filter='Filter projects'
					empty='No projects yet. Create one, then add services to it.'
				/>
			</Section>
		</Page>
	)
}

/** Managers older than the tags column answer without the field. */
function tagsOf(project: Project): string[] {
	return project.tags ?? []
}

/**
 * A project is the folder its services live in. What it runs is decided one
 * service at a time inside it, so this form only needs a name.
 */
function NewProjectForm({ knownTags, onDone }: { knownTags: string[]; onDone: () => void }) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()

	const [name, setName] = useState('')
	const [tags, setTags] = useState<string[]>([])

	const create = useMutation({
		mutationFn: () => api.createProject({ name, tags }),
		onSuccess: async project => {
			await queryClient.invalidateQueries({ queryKey: ['projects'] })
			onDone()
			await navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
		},
	})

	return (
		<form
			onSubmit={event => {
				event.preventDefault()
				create.mutate()
			}}
		>
			<div className='grid gap-x-6 md:grid-cols-2'>
				<Field label='Name'>
					<Input required value={name} onChange={event => setName(event.target.value)} placeholder='my-app' />
				</Field>

				<Field label='Tags (optional)' hint='Enter adds one, click a tag to drop it.'>
					<TagInput value={tags} onChange={setTags} suggestions={knownTags} />
				</Field>
			</div>

			<ErrorText error={create.error} />
			<DialogFooter>
				<Button variant='ghost' onClick={onDone}>
					Cancel
				</Button>
				<Button type='submit' variant='primary' disabled={create.isPending}>
					<IconPlus />
					{create.isPending ? 'Creating…' : 'Create'}
				</Button>
			</DialogFooter>
		</form>
	)
}

/**
 * Tags are plain labels: typing one and pressing Enter creates it, and tags
 * already used by other projects are offered as native autocomplete.
 */
function TagInput({
	value,
	onChange,
	suggestions,
}: {
	value: string[]
	onChange: (tags: string[]) => void
	suggestions: string[]
}) {
	const [draft, setDraft] = useState('')

	const add = (raw: string) => {
		const tag = raw
			.trim()
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/gu, '-')
			.replaceAll(/^-|-$/gu, '')
		if (tag && !value.includes(tag)) onChange([...value, tag])
		setDraft('')
	}

	return (
		<>
			<Input
				list='known-project-tags'
				value={draft}
				placeholder='staging'
				onChange={event => setDraft(event.target.value)}
				// A blur commits the draft so a typed tag is never lost on submit.
				onBlur={() => add(draft)}
				onKeyDown={event => {
					if (event.key === 'Enter' || event.key === ',') {
						event.preventDefault()
						add(draft)
					}
					if (event.key === 'Backspace' && draft === '') onChange(value.slice(0, -1))
				}}
			/>
			<datalist id='known-project-tags'>
				{suggestions.map(tag => (
					<option key={tag} value={tag}>
						{tag}
					</option>
				))}
			</datalist>
			{value.length > 0 ? (
				<div className='mt-2 flex flex-wrap gap-1.5'>
					{value.map(tag => (
						<Badge
							key={tag}
							variant='outline'
							render={
								<button
									type='button'
									aria-label={`Remove ${tag}`}
									onClick={() => onChange(value.filter(other => other !== tag))}
								/>
							}
							className='cursor-pointer hover:bg-accent'
						>
							{tag}
							<IconX />
						</Badge>
					))}
				</div>
			) : null}
		</>
	)
}
