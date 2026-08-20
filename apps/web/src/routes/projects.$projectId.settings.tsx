import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Check, ErrorText, Field, Section } from '../components/primitives'
import { api, type CredentialKind, type SourceType } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'

export const Route = createFileRoute('/projects/$projectId/settings')({ component: ProjectSettings })

function ProjectSettings() {
	const { projectId } = Route.useParams()
	const queryClient = useQueryClient()
	const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) })
	const environmentId = useEnvironmentId()
	const compose = useQuery({
		queryKey: ['compose', projectId, environmentId],
		queryFn: () => api.compose(projectId, environmentId),
	})

	const [name, setName] = useState('')
	const [sourceType, setSourceType] = useState<SourceType>('compose')
	const [branch, setBranch] = useState('')
	const [composePath, setComposePath] = useState('')
	const [repositoryUrl, setRepositoryUrl] = useState('')
	const [autoDeploy, setAutoDeploy] = useState(false)
	const [credentialKind, setCredentialKind] = useState<CredentialKind>('none')
	const [credentialSecret, setCredentialSecret] = useState('')
	const [webhookSecret, setWebhookSecret] = useState('')
	const [composeContent, setComposeContent] = useState('')

	useEffect(() => {
		if (!project.data) return
		setName(project.data.name)
		setSourceType(project.data.source_type)
		setBranch(project.data.branch)
		setComposePath(project.data.compose_path)
		setRepositoryUrl(project.data.repository_url)
		setAutoDeploy(project.data.auto_deploy)
		setCredentialKind(project.data.git_credential_kind)
	}, [project.data])

	useEffect(() => {
		if (compose.data) setComposeContent(compose.data.content)
	}, [compose.data])

	const save = useMutation({
		mutationFn: () =>
			api.updateProject(projectId, {
				name,
				source_type: sourceType,
				branch,
				compose_path: composePath,
				repository_url: repositoryUrl,
				auto_deploy: autoDeploy,
				credential_kind: credentialKind,
				credential_secret: credentialSecret,
				// Only send the webhook secret when the field was actually touched, so
				// saving other settings never clears it.
				...(webhookSecret === '' ? {} : { webhook_secret: webhookSecret }),
			}),
		onSuccess: () => {
			setCredentialSecret('')
			setWebhookSecret('')
			void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
			// A changed source starts from an empty checkout, so the editor below
			// must not keep showing the previous file.
			void queryClient.invalidateQueries({ queryKey: ['compose', projectId] })
		},
	})

	const saveCompose = useMutation({
		mutationFn: () => api.saveCompose(projectId, composeContent, environmentId),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compose', projectId] }),
	})

	const isGit = sourceType === 'git'

	return (
		<>
			<Section title='Project' onSave={() => save.mutate()}>
				<div className='grid gap-x-6 border-t border-border pt-3 md:grid-cols-2'>
					<Field label='Name'>
						<input value={name} onChange={event => setName(event.target.value)} />
					</Field>
					<Field
						label='Source'
						hint={
							sourceType === project.data?.source_type
								? undefined
								: 'Saving this empties the current checkout.'
						}
					>
						<select value={sourceType} onChange={event => setSourceType(event.target.value as SourceType)}>
							<option value='compose'>Compose file</option>
							<option value='git'>Git repository</option>
						</select>
					</Field>
					{isGit ? (
						<>
							<Field label='Repository URL'>
								<input value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} />
							</Field>
							<Field label='Branch'>
								<input value={branch} onChange={event => setBranch(event.target.value)} />
							</Field>
							<Field label='Compose file'>
								<input value={composePath} onChange={event => setComposePath(event.target.value)} />
							</Field>
							<Field label='Credentials'>
								<select
									value={credentialKind}
									onChange={event => setCredentialKind(event.target.value as CredentialKind)}
								>
									<option value='none'>Public repository</option>
									<option value='token'>Access token</option>
									<option value='ssh_key'>SSH private key</option>
								</select>
							</Field>
							{credentialKind === 'none' ? null : (
								<Field
									label={credentialKind === 'token' ? 'Token' : 'Private key'}
									hint='Leave empty to keep the stored value.'
								>
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
				</div>
				{isGit ? (
					<Check
						label='Deploy automatically when the branch is pushed'
						className='mb-3'
						checked={autoDeploy}
						onChange={setAutoDeploy}
					/>
				) : null}
				<ErrorText error={save.error} />
				<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save'}
				</Button>
			</Section>

			{isGit ? (
				<Section
					title='Webhook'
					description='point your git provider here to auto deploy'
					onSave={() => save.mutate()}
				>
					<code className='block border-t border-border pt-2 font-mono text-body break-all text-foreground'>
						{project.data?.webhook_url}
					</code>
					<div className='mt-3 max-w-md'>
						<Field
							label='Signing secret'
							hint={
								project.data?.webhook_secret_set
									? 'A secret is set. Enter a new one to replace it, or a single space to disable verification.'
									: 'Optional. When set, X-Hub-Signature-256 must match or the request is rejected.'
							}
						>
							<input
								type='password'
								value={webhookSecret}
								onChange={event => setWebhookSecret(event.target.value)}
							/>
						</Field>
						<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
							Save webhook secret
						</Button>
					</div>
				</Section>
			) : (
				<Section
					title='Compose file'
					onSave={() => saveCompose.mutate()}
					actions={
						<Button variant='primary' onClick={() => saveCompose.mutate()} disabled={saveCompose.isPending}>
							{saveCompose.isPending ? 'Saving…' : 'Save compose'}
						</Button>
					}
				>
					<ErrorText error={saveCompose.error} />
					<textarea
						rows={18}
						value={composeContent}
						onChange={event => setComposeContent(event.target.value)}
						className='font-mono text-body'
						spellCheck={false}
					/>
				</Section>
			)}

			<Environments projectId={projectId} />
			<ExportServices projectId={projectId} />
		</>
	)
}

/**
 * Environments are created and destroyed here rather than from the breadcrumb
 * picker: switching is constant, and deleting one takes its containers and
 * volumes with it.
 */
function Environments({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient()
	const [name, setName] = useState('')
	const [branch, setBranch] = useState('')
	const [confirming, setConfirming] = useState<string | null>(null)

	const environments = useQuery({ queryKey: ['environments', projectId], queryFn: () => api.environments(projectId) })
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['environments', projectId] })

	const create = useMutation({
		mutationFn: () => api.createEnvironment(projectId, { name, branch: branch || undefined }),
		onSuccess: async () => {
			setName('')
			setBranch('')
			await refresh()
		},
	})
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteEnvironment(id, true),
		onSuccess: async () => {
			setConfirming(null)
			await refresh()
		},
	})

	return (
		<Section title='Environments' description='each one deploys on its own, into its own containers'>
			<ErrorText error={create.error ?? remove.error} />
			<ul className='mb-4'>
				{environments.data?.map(env => (
					<li key={env.id} className='flex h-9 items-center gap-3 border-b'>
						<span className='text-body'>{env.name}</span>
						<span className='font-mono text-meta text-muted-foreground'>
							{env.branch || 'project branch'}
						</span>
						{env.is_default ? null : (
							<span className='ml-auto'>
								{confirming === env.id ? (
									<>
										<Button
											variant='danger'
											onClick={() => remove.mutate(env.id)}
											disabled={remove.isPending}
										>
											Delete with volumes
										</Button>
										<Button variant='ghost' onClick={() => setConfirming(null)}>
											Cancel
										</Button>
									</>
								) : (
									<Button variant='ghost' onClick={() => setConfirming(env.id)}>
										Delete
									</Button>
								)}
							</span>
						)}
					</li>
				))}
			</ul>
			<form
				className='grid gap-x-6 md:grid-cols-2'
				onSubmit={event => {
					event.preventDefault()
					create.mutate()
				}}
			>
				<Field label='Name' hint='Becomes the slug the API and the directory use.'>
					<input
						required
						value={name}
						onChange={event => setName(event.target.value)}
						placeholder='Staging'
					/>
				</Field>
				<Field label='Branch' hint='Empty follows the project’s branch.'>
					<input value={branch} onChange={event => setBranch(event.target.value)} placeholder='develop' />
				</Field>
				<div>
					<Button variant='primary' type='submit' disabled={create.isPending || !name}>
						{create.isPending ? 'Creating…' : 'Add environment'}
					</Button>
				</div>
			</form>
		</Section>
	)
}

/**
 * The other half of a service import. Secret values stay behind unless asked
 * for, because the result is base64 and base64 is not encryption: it goes on a
 * clipboard, and from there wherever clipboards go.
 */
function ExportServices({ projectId }: { projectId: string }) {
	const [secrets, setSecrets] = useState(false)
	const [copied, setCopied] = useState(false)
	const environmentId = useEnvironmentId()

	const exported = useQuery({
		queryKey: ['export', projectId, secrets, environmentId],
		queryFn: () => api.exportServices(projectId, secrets, environmentId),
	})

	return (
		<Section
			title='Export services'
			description='paste into another project’s import'
			actions={
				<Button
					variant='primary'
					disabled={!exported.data?.payload}
					onClick={async () => {
						await navigator.clipboard.writeText(exported.data?.payload ?? '')
						setCopied(true)
					}}
				>
					{copied ? 'Copied' : 'Copy'}
				</Button>
			}
		>
			<ErrorText error={exported.error} />
			<code className='block max-h-24 overflow-y-auto border-t border-border pt-2 font-mono text-label break-all text-muted-foreground'>
				{exported.data?.payload || 'No managed services to export.'}
			</code>
			<div className='mt-3'>
				<Check
					label='Include secret values'
					checked={secrets}
					onChange={next => {
						setSecrets(next)
						setCopied(false)
					}}
				/>
				<p className='mt-1 text-label text-muted-foreground'>
					Off, secrets export as keys with empty values and the import leaves the generated ones alone.
				</p>
			</div>
		</Section>
	)
}
