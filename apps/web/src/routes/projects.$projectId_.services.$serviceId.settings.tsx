import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button, ErrorText, Field, Section } from '../components/primitives'
import { api, type CredentialKind, isGitProvider, type Service, type ServiceProvider } from '../lib/api'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/settings')({
	component: ServiceSettingsRoute,
})

function ServiceSettingsRoute() {
	const { projectId, serviceId } = Route.useParams()
	const service = useService(serviceId)

	// The form is seeded from the service, so it waits for the first read
	// instead of mounting empty and overwriting what it never loaded.
	if (!service.data) return null
	// Remounts on switch, so the fields follow the service the URL names.
	return <ServiceSettings key={service.data.id} projectId={projectId} service={service.data} />
}

function ServiceSettings({ projectId, service }: { projectId: string; service: Service }) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [image, setImage] = useState(service.image)
	const [repositoryUrl, setRepositoryUrl] = useState(service.repository_url)
	const [branch, setBranch] = useState(service.branch)
	const [buildPath, setBuildPath] = useState(service.build_path)
	const [fragment, setFragment] = useState(service.compose_fragment)
	const [credentialKind, setCredentialKind] = useState<CredentialKind>(service.credential_kind || 'none')
	const [credentialSecret, setCredentialSecret] = useState('')
	const [confirmDelete, setConfirmDelete] = useState(false)

	// An application arrives here as a bare name, so this page is where it gets
	// answered, and it can be answered again later. A database's provider is
	// fixed: its volume and credentials were rendered from the engine.
	const [provider, setProvider] = useState<ServiceProvider>(
		service.provider === 'unconfigured' ? 'github' : service.provider,
	)
	const editable = service.type === 'application'
	const showing = editable ? provider : service.provider
	const git = isGitProvider(showing)

	const save = useMutation({
		mutationFn: () =>
			api.updateService(service.id, {
				...(editable ? { provider } : {}),
				...(git
					? {
							repository_url: repositoryUrl,
							branch: branch || 'main',
							build_path: buildPath,
							credential_kind: credentialKind,
							// An empty secret keeps the stored one; the manager only
							// re-encrypts what it is actually given.
							...(credentialSecret === '' ? {} : { credential_secret: credentialSecret }),
						}
					: {}),
				...(showing === 'image' ? { image } : {}),
				...(showing === 'raw' ? { compose_fragment: fragment } : {}),
			}),
		onSuccess: () => {
			setCredentialSecret('')
			void queryClient.invalidateQueries({ queryKey: ['service', service.id] })
		},
	})

	const remove = useMutation({
		mutationFn: () => api.deleteService(service.id),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
			await navigate({ to: '/projects/$projectId', params: { projectId } })
		},
	})

	return (
		<>
			<Section
				title='Settings'
				description='applied on the next deploy'
				onSave={() => save.mutate()}
				actions={
					<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
						{save.isPending ? 'Saving…' : 'Save'}
					</Button>
				}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					{editable ? (
						<Field label='Provider'>
							<select
								value={provider}
								onChange={event => setProvider(event.target.value as ServiceProvider)}
							>
								<option value='github'>GitHub</option>
								<option value='gitlab'>GitLab</option>
								<option value='bitbucket'>Bitbucket</option>
								<option value='gitea'>Gitea</option>
								<option value='git'>Any git URL</option>
								<option value='image'>Docker image</option>
								<option value='raw'>Compose file</option>
							</select>
						</Field>
					) : null}
					{git ? (
						<>
							<Field label='Repository'>
								<input value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} />
							</Field>
							<Field label='Branch'>
								<input value={branch} onChange={event => setBranch(event.target.value)} />
							</Field>
							<Field label='Build path'>
								<input value={buildPath} onChange={event => setBuildPath(event.target.value)} />
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
					{showing === 'image' ? (
						<Field
							label='Image'
							hint={
								service.type === 'database'
									? 'Changing the tag is how a database moves version.'
									: undefined
							}
						>
							<input value={image} onChange={event => setImage(event.target.value)} />
						</Field>
					) : null}
				</div>
				{showing === 'raw' ? (
					<Field label='Compose fragment'>
						<textarea
							rows={10}
							value={fragment}
							onChange={event => setFragment(event.target.value)}
							className='font-mono text-body'
							spellCheck={false}
						/>
					</Field>
				) : null}
				<ErrorText error={save.error} />
			</Section>

			<Section title='Delete service' description='its named volume is kept'>
				<ErrorText error={remove.error} />
				{confirmDelete ? (
					<div className='flex gap-2'>
						<Button variant='danger' onClick={() => remove.mutate()} disabled={remove.isPending}>
							{remove.isPending ? 'Deleting…' : `Delete ${service.compose_service_name}`}
						</Button>
						<Button variant='ghost' onClick={() => setConfirmDelete(false)}>
							Cancel
						</Button>
					</div>
				) : (
					<Button variant='danger' onClick={() => setConfirmDelete(true)}>
						Delete service
					</Button>
				)}
				<p className='mt-1 text-label text-muted-foreground'>
					Removes it from the compose overlay and drops its environment. The data volume stays, so recreating
					the service under the same name picks it back up.
				</p>
			</Section>
		</>
	)
}
