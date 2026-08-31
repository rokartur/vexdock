import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Check, ErrorText, Field, Section } from '../components/primitives'
import { api } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'

export const Route = createFileRoute('/projects/$projectId/settings')({ component: ProjectSettings })

function ProjectSettings() {
	const { projectId } = Route.useParams()
	const queryClient = useQueryClient()
	const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) })

	const [name, setName] = useState('')
	const [autoDeploy, setAutoDeploy] = useState(false)
	const [webhookSecret, setWebhookSecret] = useState('')

	useEffect(() => {
		if (!project.data) return
		setName(project.data.name)
		setAutoDeploy(project.data.auto_deploy)
	}, [project.data])

	const save = useMutation({
		mutationFn: () =>
			api.updateProject(projectId, {
				name,
				auto_deploy: autoDeploy,
				// Only send the webhook secret when the field was actually touched, so
				// saving other settings never clears it.
				...(webhookSecret === '' ? {} : { webhook_secret: webhookSecret }),
			}),
		onSuccess: () => {
			setWebhookSecret('')
			void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
		},
	})

	return (
		<>
			<Section title='Project' onSave={() => save.mutate()}>
				<div className='grid gap-x-6 border-t border-border pt-3 md:grid-cols-2'>
					<Field label='Name'>
						<input value={name} onChange={event => setName(event.target.value)} />
					</Field>
				</div>
				<Check
					label='Deploy automatically when a service’s branch is pushed'
					className='mb-3'
					checked={autoDeploy}
					onChange={setAutoDeploy}
				/>
				<ErrorText error={save.error} />
				<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save'}
				</Button>
			</Section>

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
							{env.branch || 'service branch'}
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
				<Field label='Branch' hint='Empty lets each service follow its own branch.'>
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
