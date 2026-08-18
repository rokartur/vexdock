import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
	Button,
	Cell,
	Empty,
	ErrorText,
	Field,
	Page,
	Row,
	Section,
	Skeleton,
	Status,
	Table,
} from '../components/primitives'
import { api, type SourceType } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/projects/')({ component: ProjectsPage })

function ProjectsPage() {
	const [creating, setCreating] = useState(false)
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 10_000 })

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

			<Section title='All projects' description={`${projects.data?.length ?? 0} total`}>
				{projects.isLoading ? (
					<Skeleton />
				) : projects.data?.length === 0 ? (
					<Empty>No projects yet. Create one from a Git repository, a compose file or a template.</Empty>
				) : (
					<Table head={['Name', 'Source', 'Services', 'Domains', 'Last deploy', '']}>
						{projects.data?.map(project => (
							<Row key={project.id}>
								<Cell>
									<Link
										to='/projects/$projectId'
										params={{ projectId: project.id }}
										className='hover:underline'
									>
										{project.name}
									</Link>
								</Cell>
								<Cell mono>
									{project.source_type === 'git' ? shortRepo(project.repository_url) : 'compose'}
									{project.source_type === 'git' ? (
										<span className='text-zinc-600'> @{project.branch}</span>
									) : null}
								</Cell>
								<Cell mono>
									{project.running_count}/{project.service_count}
								</Cell>
								<Cell mono>{project.domains.length || '-'}</Cell>
								<Cell>
									{project.latest_deployment ? (
										<span className='flex items-center gap-2'>
											<Status value={project.latest_deployment.status} />
											<span className='text-muted-foreground'>
												{since(project.latest_deployment.created_at)}
											</span>
										</span>
									) : (
										<span className='text-muted-foreground'>never</span>
									)}
								</Cell>
								<Cell right>
									<Link
										to='/projects/$projectId'
										params={{ projectId: project.id }}
										className='text-[13px] text-muted-foreground hover:text-white'
									>
										open
									</Link>
								</Cell>
							</Row>
						))}
					</Table>
				)}
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
					<label key={option} className='flex items-center gap-1.5 text-[13px]'>
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
									className='font-mono text-[13px]'
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
						className='font-mono text-[13px]'
					/>
				</Field>
			) : null}

			<div className='mb-3 flex flex-wrap gap-4'>
				{source === 'git' ? (
					<label className='flex items-center gap-1.5 text-[13px]'>
						<input
							type='checkbox'
							className='!w-auto'
							checked={autoDeploy}
							onChange={event => setAutoDeploy(event.target.checked)}
						/>
						Auto deploy on push
					</label>
				) : null}
				<label className='flex items-center gap-1.5 text-[13px]'>
					<input
						type='checkbox'
						className='!w-auto'
						checked={deployNow}
						onChange={event => setDeployNow(event.target.checked)}
					/>
					Deploy immediately
				</label>
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
