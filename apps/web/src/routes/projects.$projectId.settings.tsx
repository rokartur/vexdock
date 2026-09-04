import { useEffect, useState } from 'react'
import {
	IconCheck,
	IconCopy,
	IconFolder,
	IconGitBranch,
	IconLayersLinked,
	IconPlus,
	IconTrash,
	IconUpload,
	IconWebhook,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormSection,
	IconButton,
	Input,
	SaveButton,
	Switch,
} from '../components/primitives'
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
		<div className='max-w-3xl'>
			<ErrorText error={save.error} />
			<FormSection
				title='Project'
				icon={IconFolder}
				hint='The name is what the breadcrumb and the project list show.'
				actions={<SaveButton pending={save.isPending} />}
				onSave={() => save.mutate()}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Name'>
						<Input value={name} onChange={event => setName(event.target.value)} />
					</Field>
				</div>
				<Switch
					label='Deploy automatically when a service’s branch is pushed'
					checked={autoDeploy}
					onChange={setAutoDeploy}
				/>
			</FormSection>

			<FormSection
				title='Webhook'
				description='Point your git provider here to auto deploy.'
				icon={IconWebhook}
				hint={
					project.data?.webhook_secret_set
						? 'A secret is set. Enter a new one to replace it, or a single space to disable verification.'
						: 'Optional. When set, X-Hub-Signature-256 must match or the request is rejected.'
				}
				actions={<SaveButton pending={save.isPending} label='Save webhook secret' />}
				onSave={() => save.mutate()}
			>
				<code className='mb-4 block rounded-md border bg-background px-3 py-2 font-mono text-label break-all'>
					{project.data?.webhook_url}
				</code>
				<div className='max-w-md'>
					<Field label='Signing secret'>
						<Input
							type='password'
							value={webhookSecret}
							onChange={event => setWebhookSecret(event.target.value)}
						/>
					</Field>
				</div>
			</FormSection>

			<Environments projectId={projectId} />
			<ExportServices projectId={projectId} />
		</div>
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
		onSuccess: refresh,
	})

	return (
		<FormSection
			title='Environments'
			description='Each one deploys on its own, into its own containers.'
			icon={IconLayersLinked}
			hint='A name becomes the slug the API and the directory use. An empty branch lets each service follow its own.'
			actions={
				<Button type='submit' variant='primary' disabled={create.isPending}>
					<IconPlus />
					{create.isPending ? 'Creating…' : 'Add environment'}
				</Button>
			}
			onSave={() => create.mutate()}
		>
			<ErrorText error={create.error ?? remove.error} />
			<ul className='mb-4 rounded-md border bg-background'>
				{environments.data?.map(env => (
					<li key={env.id} className='flex h-9 items-center gap-3 border-b px-3 last:border-b-0'>
						<IconLayersLinked className='size-4 text-muted-foreground' />
						<span className='text-body'>{env.name}</span>
						{env.is_default ? <Badge variant='outline'>default</Badge> : null}
						<span className='inline-flex items-center gap-1 font-mono text-meta text-muted-foreground'>
							<IconGitBranch className='size-3' />
							{env.branch || 'service branch'}
						</span>
						{env.is_default ? null : (
							<span className='ml-auto'>
								<Confirm
									title={`Delete ${env.name}?`}
									description='Its containers and volumes are removed with it.'
									action='Delete with volumes'
									onConfirm={() => remove.mutate(env.id)}
								>
									<IconButton icon={IconTrash} label='Delete' disabled={remove.isPending} />
								</Confirm>
							</span>
						)}
					</li>
				))}
			</ul>
			<div className='grid gap-x-6 md:grid-cols-2'>
				<Field label='Name'>
					<Input
						required
						value={name}
						onChange={event => setName(event.target.value)}
						placeholder='Staging'
					/>
				</Field>
				<Field label='Branch'>
					<Input value={branch} onChange={event => setBranch(event.target.value)} placeholder='develop' />
				</Field>
			</div>
		</FormSection>
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
		<FormSection
			title='Export services'
			description='Paste into another project’s import.'
			icon={IconUpload}
			hint='With secrets off, they export as keys with empty values and the import leaves the generated ones alone.'
			actions={
				<Button
					variant='primary'
					disabled={!exported.data?.payload}
					onClick={async () => {
						await navigator.clipboard.writeText(exported.data?.payload ?? '')
						setCopied(true)
					}}
				>
					{copied ? <IconCheck /> : <IconCopy />}
					{copied ? 'Copied' : 'Copy'}
				</Button>
			}
		>
			<ErrorText error={exported.error} />
			<code className='mb-4 block max-h-24 overflow-y-auto rounded-md border bg-background px-3 py-2 font-mono text-label break-all text-muted-foreground'>
				{exported.data?.payload || 'No managed services to export.'}
			</code>
			<Switch
				label='Include secret values'
				checked={secrets}
				onChange={next => {
					setSecrets(next)
					setCopied(false)
				}}
			/>
		</FormSection>
	)
}
