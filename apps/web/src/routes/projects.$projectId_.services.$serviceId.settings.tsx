import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button, ErrorText, Field, Section } from '../components/primitives'
import { api, type Service } from '../lib/api'
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
	const [confirmDelete, setConfirmDelete] = useState(false)

	// An application arrives here as a bare name, so this page is where its
	// source gets answered. Once saved the answer sticks and the select goes
	// away: the checkout and the env file already hang off it.
	const pending = service.source_type === 'unconfigured'
	const [source, setSource] = useState<'git' | 'image'>('git')
	const showing = pending ? source : service.source_type

	const save = useMutation({
		mutationFn: () =>
			api.updateService(service.id, {
				...(pending ? { source_type: source } : {}),
				...(showing === 'git'
					? { repository_url: repositoryUrl, branch: branch || 'main', build_path: buildPath }
					: {}),
				...(showing === 'image' ? { image } : {}),
				...(showing === 'compose' ? { compose_fragment: fragment } : {}),
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', service.id] }),
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
					{pending ? (
						<Field label='Source' hint='Set once. To change it later, delete the service and add it again.'>
							<select
								value={source}
								onChange={event => setSource(event.target.value === 'image' ? 'image' : 'git')}
							>
								<option value='git'>Git repository</option>
								<option value='image'>Docker image</option>
							</select>
						</Field>
					) : null}
					{showing === 'git' ? (
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
				{showing === 'compose' ? (
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
