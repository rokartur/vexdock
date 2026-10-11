import { useEffect, useMemo, useState } from 'react'
import { IconFolder, IconGitBranch, IconLayersLinked, IconPlus, IconTrash, IconUpload } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { CopyButton } from '@/components/ui/copy-button'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormDialog,
	FormSection,
	IconButton,
	Input,
	RelativeTime,
	SaveButton,
	Switch,
} from '../components/primitives'
import { api, type Environment } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
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
	const queryClient = useQueryClient()
	const project = useQuery(projectQuery(projectId))

	const [name, setName] = useState('')

	useEffect(() => {
		if (!project.data) return
		setName(project.data.name)
	}, [project.data])

	const save = useMutation({
		mutationFn: () => api.updateProject(projectId, { name }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
		},
	})

	return (
		<div className='max-w-3xl'>
			<ErrorText error={save.error} />
			<FormSection
				title='Project'
				icon={IconFolder}
				hint='The name is what the breadcrumb and the project list show. The slug it was created with never moves.'
				actions={
					<SaveButton mutation={save} dirty={project.data !== undefined && name !== project.data.name} />
				}
				aside={
					project.data
						? [
								{
									label: 'Slug',
									value: <span className='font-mono text-xs'>{project.data.slug}</span>,
								},
								{
									label: 'Services',
									value: `${project.data.running_count} of ${project.data.service_count} running`,
								},
								{ label: 'Created', value: <RelativeTime at={project.data.created_at} /> },
							]
						: []
				}
				onSave={() => save.mutate()}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Name'>
						<Input value={name} onChange={event => setName(event.target.value)} />
					</Field>
				</div>
			</FormSection>

			<Environments projectId={projectId} />
			<ExportServices projectId={projectId} />
		</div>
	)
}

function environmentColumns(remove: (id: string) => void, removing: boolean): Columns<Environment> {
	const cell = columnsFor<Environment>()
	return [
		cell.accessor(environment => environment.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2 font-medium'>
					<IconLayersLinked className='size-4 text-muted' />
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
						<IconGitBranch className='size-3 text-muted' />
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
			cell: ({ row }) =>
				row.original.is_default ? null : (
					<Confirm
						title={`Delete ${row.original.name}?`}
						description='Its containers and volumes are removed with it.'
						action='Delete with volumes'
						type={row.original.name}
						onConfirm={() => remove(row.original.id)}
					>
						<IconButton icon={IconTrash} label='Delete' disabled={removing} />
					</Confirm>
				),
		}),
	]
}

/** Not in the breadcrumb picker, where switching is constant: deleting one takes its containers and volumes. */
function Environments({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient()
	const [adding, setAdding] = useState(false)
	const [name, setName] = useState('')
	const [branch, setBranch] = useState('')

	const environments = useQuery(environmentsQuery(projectId))
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['environments', projectId] })

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
		onSuccess: refresh,
	})

	const { mutate: removeEnvironment, isPending: removing } = remove
	const columns = useMemo(() => environmentColumns(removeEnvironment, removing), [removeEnvironment, removing])

	return (
		<FormSection
			title='Environments'
			icon={IconLayersLinked}
			actions={
				<Button variant='primary' onClick={() => setAdding(true)}>
					<IconPlus />
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
				empty='No environments yet.'
			/>
			<FormDialog
				open={adding}
				onOpenChange={setAdding}
				title='Add environment'
				description='A name becomes the slug the API and the directory use.'
				action={create.isPending ? 'Creating…' : 'Add environment'}
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
						<Input value={branch} onChange={event => setBranch(event.target.value)} placeholder='develop' />
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

	const exported = useQuery(exportQuery(projectId, secrets, environmentId))

	return (
		<FormSection
			title='Export services'
			icon={IconUpload}
			hint='With secrets off, they export as keys with empty values and the import leaves the generated ones alone.'
			actions={
				<CopyButton
					variant='primary'
					value={exported.data?.payload ?? ''}
					disabled={!exported.data?.payload}
					onError={() => setCopyError('Copying needs HTTPS. Select the text below and copy it by hand.')}
				/>
			}
		>
			<ErrorText error={exported.error ?? copyError} />
			<code className='mb-4 block max-h-24 overflow-y-auto rounded-control border bg-background px-3 py-2 font-mono text-xs break-all text-muted'>
				{exported.data?.payload || 'No managed services to export.'}
			</code>
			<Switch label='Include secret values' checked={secrets} onChange={setSecrets} />
		</FormSection>
	)
}
