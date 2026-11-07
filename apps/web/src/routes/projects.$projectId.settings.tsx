import { useMemo, useState } from 'react'
import {
	IconFolder,
	IconGitBranch,
	IconLayersLinked,
	IconPencil,
	IconPlus,
	IconTrash,
	IconUpload,
} from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { CopyButton } from '@/components/ui/copy-button'
import { Skeleton } from '@/components/ui/skeleton'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { ProjectTags } from '../components/new-project'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormDialog,
	FormSection,
	FormSkeleton,
	IconButton,
	Input,
	RelativeTime,
	SaveButton,
	Switch,
} from '../components/primitives'
import { api, type Environment, type Project } from '../lib/api'
import { useCurrentEnvironment, useEnvironmentId } from '../lib/environment'
import { environmentsQuery, preload, projectQuery } from '../lib/queries'

const exportQuery = (projectId: string, secrets: boolean, environmentId: string | undefined) =>
	queryOptions({
		queryKey: ['export', projectId, secrets, environmentId],
		queryFn: () => api.exportServices(projectId, secrets, environmentId),
	})

export const Route = createFileRoute('/projects/$projectId/settings')({
	loaderDeps: ({ search }) => ({ env: search.env }),
	loader: ({ context: { queryClient }, params: { projectId }, deps: { env } }) =>
		preload(queryClient, exportQuery(projectId, false, env)),
	component: ProjectSettings,
})

function ProjectSettings() {
	const { projectId } = Route.useParams()
	const project = useQuery(projectQuery(projectId))

	return (
		<div className='max-w-3xl'>
			{project.isPending ? <FormSkeleton label='Loading the project' cards={1} /> : null}
			{project.data ? <ProjectCard key={projectId} project={project.data} /> : null}
			<Environments projectId={projectId} />
			<ExportServices projectId={projectId} />
		</div>
	)
}

/** The draft starts from the loaded name and tags; a refetch (a service starting changes the project) leaves it alone. */
function ProjectCard({ project }: { project: Project }) {
	const queryClient = useQueryClient()
	const [name, setName] = useState(project.name)
	const [tags, setTags] = useState(project.tags)

	const save = useMutation({
		mutationFn: () => api.updateProject(project.id, { name, tags }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['project', project.id] })
			void queryClient.invalidateQueries({ queryKey: ['projects'] })
		},
	})

	return (
		<FormSection
			title='Project'
			icon={IconFolder}
			hint='The name is what the breadcrumb and the project list show. A rename also moves the slug. Tags group projects in the list.'
			actions={
				<SaveButton
					mutation={save}
					dirty={name !== project.name || tags.join(',') !== project.tags.join(',')}
				/>
			}
			aside={[
				{ label: 'Slug', value: <span className='font-mono text-xs'>{project.slug}</span> },
				{
					label: 'Services',
					value: `${project.running_count} of ${project.service_count} running, all environments`,
				},
				{ label: 'Created', value: <RelativeTime at={project.created_at} /> },
			]}
			onSave={() => save.mutate()}
		>
			<ErrorText error={save.error} />
			<div className='grid gap-x-6 md:grid-cols-2'>
				<Field label='Name'>
					<Input value={name} onChange={event => setName(event.target.value)} />
				</Field>
				<ProjectTags label='Tags' value={tags} onChange={setTags} />
			</div>
		</FormSection>
	)
}

function environmentColumns(
	edit: (environment: Environment) => void,
	remove: (id: string) => void,
	removing: string | undefined,
): Columns<Environment> {
	const cell = columnsFor<Environment>()
	return [
		cell.accessor(environment => environment.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2 font-medium'>
					<IconLayersLinked stroke={1.75} className='size-4 text-muted' />
					{row.original.name}
					{row.original.is_default ? <Badge>default</Badge> : null}
				</span>
			),
		}),
		cell.accessor(environment => environment.compose_project_name, {
			id: 'compose',
			header: 'Compose project',
			meta: { mono: true },
		}),
		cell.accessor(environment => environment.branch, {
			id: 'branch',
			header: 'Branch',
			cell: ({ row }) =>
				row.original.branch ? (
					<span className='inline-flex items-center gap-1 font-mono text-xs'>
						<IconGitBranch stroke={1.75} className='size-3 text-muted' />
						{row.original.branch}
					</span>
				) : (
					<span className='text-xs text-muted'>service branch</span>
				),
		}),
		cell.accessor(environment => environment.created_at, {
			id: 'created',
			header: 'Created',
			meta: { align: 'right' },
			cell: ({ row }) => <RelativeTime at={row.original.created_at} />,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-1'>
					<IconButton
						icon={IconPencil}
						label={`Edit ${row.original.name}`}
						onClick={() => edit(row.original)}
					/>
					{row.original.is_default ? null : (
						<Confirm
							title={`Delete ${row.original.name}?`}
							description='Its services, their domains, containers and volumes are removed with it.'
							action='Delete environment'
							type={row.original.name}
							onConfirm={() => remove(row.original.id)}
						>
							<IconButton
								icon={IconTrash}
								label={`Delete ${row.original.name}`}
								loading={removing === row.original.id}
								disabled={removing !== undefined}
							/>
						</Confirm>
					)}
				</span>
			),
		}),
	]
}

/** Not in the breadcrumb picker, where switching is constant: deleting one takes its containers and volumes. */
function Environments({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const environmentId = useEnvironmentId()
	const [adding, setAdding] = useState(false)
	const [name, setName] = useState('')
	const [branch, setBranch] = useState('')

	const environments = useQuery(environmentsQuery(projectId))
	// Deleting an environment deletes its services, which the project list counts.
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ['environments', projectId] }),
			queryClient.invalidateQueries({ queryKey: ['services', projectId] }),
			queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
			queryClient.invalidateQueries({ queryKey: ['projects'] }),
		])

	const create = useMutation({
		mutationFn: () => api.createEnvironment(projectId, { name, branch: branch || undefined }),
		onSuccess: async () => {
			setName('')
			setBranch('')
			setAdding(false)
			await refresh()
		},
	})
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteEnvironment(id, true),
		onSuccess: async (_, id) => {
			// The URL still naming the deleted environment would 404 every project read.
			if (id === environmentId) await navigate({ to: '.', search: { env: undefined }, replace: true })
			await refresh()
		},
	})

	const [editing, setEditing] = useState<Environment>()
	const [editName, setEditName] = useState('')
	const [editBranch, setEditBranch] = useState('')
	const update = useMutation({
		mutationFn: (id: string) => api.updateEnvironment(id, { name: editName, branch: editBranch }),
		onSuccess: async () => {
			setEditing(undefined)
			await refresh()
		},
	})

	const { mutate: removeEnvironment } = remove
	const removing = remove.isPending ? remove.variables : undefined
	const columns = useMemo(
		() =>
			environmentColumns(
				environment => {
					setEditName(environment.name)
					setEditBranch(environment.branch)
					setEditing(environment)
				},
				removeEnvironment,
				removing,
			),
		[removeEnvironment, removing],
	)

	return (
		<FormSection
			title='Environments'
			icon={IconLayersLinked}
			hint='Each environment runs its own containers and volumes. Deleting one removes both.'
			actions={
				<Button size='sm' onClick={() => setAdding(true)}>
					<IconPlus size={16} stroke={1.75} />
					Add environment
				</Button>
			}
		>
			<ErrorText error={remove.error} />
			<DataTable
				data={environments.data ?? []}
				columns={columns}
				loading={environments.isLoading}
				error={environments.error}
				getRowId={environment => environment.id}
				empty='No environments yet'
			/>
			<FormDialog
				open={adding}
				onOpenChange={open => {
					setAdding(open)
					if (open) return
					setName('')
					setBranch('')
				}}
				title='Add environment'
				description='A name becomes the slug the API and the directory use.'
				action='Add environment'
				icon={IconPlus}
				mutation={create}
				onSubmit={() => create.mutate()}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Name'>
						<Input
							required
							value={name}
							onChange={event => setName(event.target.value)}
							placeholder='Staging'
						/>
					</Field>
					<Field label='Branch (optional)'>
						<Input
							mono
							value={branch}
							onChange={event => setBranch(event.target.value)}
							placeholder='develop'
						/>
					</Field>
				</div>
			</FormDialog>
			<FormDialog
				open={editing !== undefined}
				onOpenChange={open => {
					if (!open) setEditing(undefined)
				}}
				title={`Edit ${editing?.name ?? 'environment'}`}
				description='Its containers, directory and compose project stay as they are. A new branch applies on the next deploy.'
				action='Save environment'
				icon={IconPencil}
				mutation={update}
				onSubmit={() => editing && update.mutate(editing.id)}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Name'>
						<Input required value={editName} onChange={event => setEditName(event.target.value)} />
					</Field>
					<Field label='Branch (optional)'>
						<Input
							mono
							value={editBranch}
							onChange={event => setEditBranch(event.target.value)}
							placeholder='service branch'
						/>
					</Field>
				</div>
			</FormDialog>
		</FormSection>
	)
}

/** Secrets stay behind unless asked for, because base64 is not encryption and this lands on a clipboard. */
function ExportServices({ projectId }: { projectId: string }) {
	const [secrets, setSecrets] = useState(false)
	const [copyError, setCopyError] = useState<string | null>(null)
	const environmentId = useEnvironmentId()
	const { current } = useCurrentEnvironment(projectId)
	const exported = useQuery(exportQuery(projectId, secrets, environmentId))
	const where = current ? `the ${current.name} environment` : 'this environment'

	return (
		<FormSection
			title='Export services'
			icon={IconUpload}
			hint={`Exports ${where}. With secrets off, they export as keys with empty values and the import leaves the generated ones alone.`}
			actions={
				<CopyButton
					value={exported.data?.payload ?? ''}
					label='Copy export'
					disabled={!exported.data?.payload}
					onCopied={() => setCopyError(null)}
					onError={() => setCopyError('Copying needs HTTPS. Select the text below and copy it by hand.')}
				/>
			}
		>
			<ErrorText error={exported.error ?? copyError} />
			{exported.isPending ? (
				<Skeleton label='Loading the export' lines={2} className='mb-4' />
			) : exported.data ? (
				// Inside a FormSection body (p-5): inner corner = surface - padding, never under 6px.
				<code
					// Keyboard scrolling needs focus, and the box holds only text.
					tabIndex={0}
					role='region'
					aria-label='Export payload'
					className='mb-4 block max-h-24 overflow-y-auto rounded-[max(6px,calc(var(--radius-surface)-20px))] border bg-background px-3 py-2 font-mono text-xs wrap-anywhere text-muted'
				>
					{exported.data.payload || `No managed services in ${where} to export.`}
				</code>
			) : null}
			<Switch label='Include secret values' checked={secrets} onChange={setSecrets} />
		</FormSection>
	)
}
