import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, Check, ErrorText, Field, Page, Refresh, Section, Status } from '../components/primitives'
import { api, type Project, type SourceType } from '../lib/api'
import { since } from '../lib/format'

const projectTableColumns: Columns<Project> = (() => {
	const cell = columnsFor<Project>()
	return [
		cell.accessor(project => project.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<Link to='/projects/$projectId' params={{ projectId: row.original.id }} className='hover:underline'>
					{row.original.name}
				</Link>
			),
		}),
		cell.accessor(project => (project.source_type === 'git' ? shortRepo(project.repository_url) : 'compose'), {
			id: 'source',
			header: 'Source',
			meta: { mono: true },
			cell: ({ row: { original } }) => (
				<>
					{original.source_type === 'git' ? shortRepo(original.repository_url) : 'compose'}
					{original.source_type === 'git' ? (
						<span className='text-muted-foreground'> @{original.branch}</span>
					) : null}
				</>
			),
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
				<Link
					to='/projects/$projectId'
					params={{ projectId: row.original.id }}
					className='text-body text-muted-foreground hover:text-foreground'
				>
					open
				</Link>
			),
		}),
	]
})()

export const Route = createFileRoute('/projects/')({ component: ProjectsPage })

function ProjectsPage() {
	const [creating, setCreating] = useState(false)
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 10_000 })

	const data = projects.data ?? []

	return (
		<Page
			title='Projects'
			actions={
				<Button variant='primary' onClick={() => setCreating(open => !open)}>
					{creating ? 'Cancel' : 'New project'}
				</Button>
			}
		>
			{creating ? <NewProjectWizard onDone={() => setCreating(false)} /> : null}

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
					empty='No projects yet. Create one from a Git repository, a compose file or a template.'
				/>
			</Section>
		</Page>
	)
}

function shortRepo(url: string): string {
	return url.replace(/^https?:\/\//u, '').replace(/\.git$/u, '')
}

/** The New Project wizard from the plan: source, repository, compose, deploy. */
function NewProjectWizard({ onDone }: { onDone: () => void }) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates, staleTime: Infinity })

	const [source, setSource] = useState<SourceType | 'template'>('git')
	const [name, setName] = useState('')
	const [repositoryUrl, setRepositoryUrl] = useState('')
	const [branch, setBranch] = useState('main')
	const [composePath, setComposePath] = useState('compose.yml')
	const [composeContent, setComposeContent] = useState('services:\n  web:\n    image: nginx\n')
	const [template, setTemplate] = useState('')
	const [autoDeploy, setAutoDeploy] = useState(true)
	const [credentialKind, setCredentialKind] = useState<'none' | 'token' | 'ssh_key'>('none')
	const [credentialSecret, setCredentialSecret] = useState('')
	const [deployNow, setDeployNow] = useState(true)

	const create = useMutation({
		mutationFn: async () => {
			const project = await api.createProject({
				name,
				source_type: source === 'template' ? 'compose' : source,
				repository_url: source === 'git' ? repositoryUrl : undefined,
				branch: source === 'git' ? branch : undefined,
				compose_path: source === 'git' ? composePath : undefined,
				compose_content: source === 'compose' ? composeContent : undefined,
				template: source === 'template' ? template : undefined,
				auto_deploy: source === 'git' ? autoDeploy : false,
				credential_kind: source === 'git' ? credentialKind : 'none',
				credential_secret: source === 'git' ? credentialSecret : undefined,
			})
			if (deployNow) await api.deploy(project.id)
			return project
		},
		onSuccess: async project => {
			await queryClient.invalidateQueries({ queryKey: ['projects'] })
			onDone()
			await navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
		},
	})

	return (
		<form
			className='mb-8 border border-border p-4'
			onSubmit={event => {
				event.preventDefault()
				create.mutate()
			}}
		>
			<div className='mb-4 flex gap-4'>
				{(['git', 'compose', 'template'] as const).map(option => (
					<label key={option} className='flex items-center gap-1.5 text-body'>
						<input
							type='radio'
							name='source'
							className='!w-auto'
							checked={source === option}
							onChange={() => setSource(option)}
						/>
						{option === 'git' ? 'Git repository' : option === 'compose' ? 'Docker Compose' : 'Template'}
					</label>
				))}
			</div>

			<div className='grid gap-x-6 md:grid-cols-2'>
				<Field label='Project name'>
					<input required value={name} onChange={event => setName(event.target.value)} placeholder='my-app' />
				</Field>

				{source === 'git' ? (
					<>
						<Field label='Repository URL'>
							<input
								required
								value={repositoryUrl}
								onChange={event => setRepositoryUrl(event.target.value)}
								placeholder='https://github.com/user/app'
							/>
						</Field>
						<Field label='Branch'>
							<input required value={branch} onChange={event => setBranch(event.target.value)} />
						</Field>
						<Field label='Compose file' hint='Path inside the repository.'>
							<input
								required
								value={composePath}
								onChange={event => setComposePath(event.target.value)}
							/>
						</Field>
						<Field label='Private repository'>
							<select
								value={credentialKind}
								onChange={event => setCredentialKind(event.target.value as typeof credentialKind)}
							>
								<option value='none'>Public</option>
								<option value='token'>Access token</option>
								<option value='ssh_key'>SSH private key</option>
							</select>
						</Field>
						{credentialKind === 'none' ? null : (
							<Field label={credentialKind === 'token' ? 'Token' : 'Private key'}>
								<textarea
									rows={credentialKind === 'token' ? 1 : 5}
									value={credentialSecret}
									onChange={event => setCredentialSecret(event.target.value)}
									className='font-mono text-body'
								/>
							</Field>
						)}
					</>
				) : null}

				{source === 'template' ? (
					<Field label='Template'>
						<select value={template} onChange={event => setTemplate(event.target.value)} required>
							<option value=''>Select a service…</option>
							{templates.data?.map(item => (
								<option key={item.slug} value={item.slug}>
									{item.name}
								</option>
							))}
						</select>
					</Field>
				) : null}
			</div>

			{source === 'compose' ? (
				<Field label='compose.yml'>
					<textarea
						rows={10}
						value={composeContent}
						onChange={event => setComposeContent(event.target.value)}
						className='font-mono text-body'
					/>
				</Field>
			) : null}

			<div className='mb-3 flex flex-wrap gap-4'>
				{source === 'git' ? (
					<Check label='Auto deploy on push' checked={autoDeploy} onChange={setAutoDeploy} />
				) : null}
				<Check label='Deploy immediately' checked={deployNow} onChange={setDeployNow} />
			</div>

			<ErrorText error={create.error} />
			<div className='flex gap-2'>
				<Button type='submit' variant='primary' disabled={create.isPending}>
					{create.isPending ? 'Creating…' : 'Create project'}
				</Button>
				<Button variant='ghost' onClick={onDone}>
					Cancel
				</Button>
			</div>
		</form>
	)
}
