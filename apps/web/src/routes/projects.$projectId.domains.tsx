import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Cell, Empty, ErrorText, Field, Row, Section, Skeleton, Status, Table } from '../components/primitives'
import { api, type CertificateSource, type Domain } from '../lib/api'

export const Route = createFileRoute('/projects/$projectId/domains')({ component: ProjectDomains })

function ProjectDomains() {
	const { projectId } = Route.useParams()
	const queryClient = useQueryClient()
	const [warning, setWarning] = useState('')

	const domains = useQuery({ queryKey: ['domains', projectId], queryFn: () => api.projectDomains(projectId) })
	const services = useQuery({ queryKey: ['services', projectId], queryFn: () => api.services(projectId) })
	const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })

	const [hostname, setHostname] = useState('')
	const [service, setService] = useState('')
	const [port, setPort] = useState(3000)
	const [https, setHttps] = useState(true)
	const [redirect, setRedirect] = useState(true)
	const [source, setSource] = useState<CertificateSource>('letsencrypt')
	const [certPem, setCertPem] = useState('')
	const [keyPem, setKeyPem] = useState('')
	// An uploaded certificate expires and has to be replaced by hand.
	const [replacing, setReplacing] = useState<Domain | null>(null)
	const [replaceCert, setReplaceCert] = useState('')
	const [replaceKey, setReplaceKey] = useState('')

	const invalidate = async () => {
		await queryClient.invalidateQueries({ queryKey: ['domains', projectId] })
		await queryClient.invalidateQueries({ queryKey: ['certificates'] })
	}

	const create = useMutation({
		mutationFn: () =>
			api.createDomain({
				project_id: projectId,
				service,
				hostname,
				container_port: port,
				https_enabled: https,
				redirect_https: redirect,
				certificate_source: source,
				certificate_pem: source === 'custom' ? certPem : undefined,
				private_key_pem: source === 'custom' ? keyPem : undefined,
			}),
		onSuccess: async result => {
			setWarning(result.warning ?? '')
			setHostname('')
			setCertPem('')
			setKeyPem('')
			await invalidate()
		},
	})

	const remove = useMutation({
		mutationFn: (id: string) => api.deleteDomain(id),
		onSuccess: invalidate,
	})

	const issue = useMutation({
		mutationFn: (id: string) => api.issueCertificate(id),
		onSuccess: invalidate,
	})

	const replace = useMutation({
		mutationFn: (id: string) =>
			api.updateDomain(id, {
				certificate_source: 'custom',
				certificate_pem: replaceCert,
				private_key_pem: replaceKey,
			}),
		onSuccess: async () => {
			setReplacing(null)
			setReplaceCert('')
			setReplaceKey('')
			await invalidate()
		},
	})

	const certificateFor = (domainId: string) => certificates.data?.find(cert => cert.domain_id === domainId)

	return (
		<>
			<Section title='Domains' description='the platform generates and reloads Nginx for you'>
				{domains.isLoading ? (
					<Skeleton rows={2} />
				) : domains.data?.length === 0 ? (
					<Empty>No domains yet. Point an A record at this server, then add it below.</Empty>
				) : (
					<Table head={['Domain', 'Service', 'Port', 'HTTPS', 'Source', 'Certificate', '']}>
						{domains.data?.map(domain => {
							const certificate = certificateFor(domain.id)
							return (
								<Row key={domain.id}>
									<Cell mono>
										<a
											href={`${domain.https_enabled ? 'https' : 'http'}://${domain.hostname}`}
											target='_blank'
											rel='noreferrer'
											className='hover:underline'
										>
											{domain.hostname}
										</a>
									</Cell>
									<Cell mono>
										{services.data?.find(item => item.id === domain.service_id)
											?.compose_service_name ?? '-'}
									</Cell>
									<Cell mono>{domain.container_port}</Cell>
									<Cell>{domain.https_enabled ? 'on' : 'off'}</Cell>
									<Cell>{domain.certificate_source === 'custom' ? 'uploaded' : "Let's Encrypt"}</Cell>
									<Cell>
										{certificate ? (
											<span className='flex items-center gap-2'>
												<Status value={certificate.status} />
												{certificate.expires_at ? (
													<span className='text-[12px] text-muted-foreground'>
														until {certificate.expires_at.slice(0, 10)}
													</span>
												) : null}
											</span>
										) : (
											<span className='text-zinc-600'>none</span>
										)}
									</Cell>
									<Cell right>
										<span className='flex justify-end gap-1.5'>
											{domain.https_enabled && domain.certificate_source !== 'custom' ? (
												<Button
													variant='ghost'
													onClick={() => issue.mutate(domain.id)}
													disabled={issue.isPending}
												>
													renew
												</Button>
											) : null}
											{domain.certificate_source === 'custom' ? (
												<Button variant='ghost' onClick={() => setReplacing(domain)}>
													replace certificate
												</Button>
											) : null}
											<Button variant='ghost' onClick={() => remove.mutate(domain.id)}>
												remove
											</Button>
										</span>
									</Cell>
								</Row>
							)
						})}
					</Table>
				)}
				<ErrorText error={remove.error ?? issue.error} />
				{certificates.data?.some(cert => cert.status === 'failed') ? (
					<p className='pt-2 text-[13px] text-amber-400'>
						{certificates.data.find(cert => cert.status === 'failed')?.last_error}
					</p>
				) : null}
			</Section>

			{replacing ? (
				<Section title={`Replace the certificate for ${replacing.hostname}`}>
					<form
						className='grid gap-x-6 border-t pt-3 md:grid-cols-2'
						onSubmit={event => {
							event.preventDefault()
							replace.mutate(replacing.id)
						}}
					>
						<Field label='Certificate' hint='Full chain in PEM: the leaf first, then any intermediates.'>
							<textarea
								rows={7}
								required
								spellCheck={false}
								value={replaceCert}
								onChange={event => setReplaceCert(event.target.value)}
								className='font-mono text-[12px]'
							/>
						</Field>
						<Field label='Private key'>
							<textarea
								rows={7}
								required
								spellCheck={false}
								value={replaceKey}
								onChange={event => setReplaceKey(event.target.value)}
								className='font-mono text-[12px]'
							/>
						</Field>
						<div className='md:col-span-2'>
							<ErrorText error={replace.error} />
							<div className='flex gap-2'>
								<Button type='submit' variant='primary' disabled={replace.isPending}>
									{replace.isPending ? 'Installing…' : 'Install certificate'}
								</Button>
								<Button variant='ghost' onClick={() => setReplacing(null)}>
									Cancel
								</Button>
							</div>
						</div>
					</form>
				</Section>
			) : null}

			<Section title='Add domain'>
				<form
					className='grid gap-x-6 border-t border-border pt-3 md:grid-cols-4'
					onSubmit={event => {
						event.preventDefault()
						create.mutate()
					}}
				>
					<Field label='Domain'>
						<input
							required
							placeholder='app.example.com'
							value={hostname}
							onChange={event => setHostname(event.target.value)}
						/>
					</Field>
					<Field label='Service'>
						<select required value={service} onChange={event => setService(event.target.value)}>
							<option value=''>Select…</option>
							{services.data?.map(item => (
								<option key={item.id} value={item.compose_service_name}>
									{item.compose_service_name}
								</option>
							))}
						</select>
					</Field>
					<Field label='Container port'>
						<input
							type='number'
							required
							min={1}
							max={65_535}
							value={port}
							onChange={event => setPort(Number(event.target.value))}
						/>
					</Field>
					<div className='flex flex-col justify-center gap-1.5 pb-3'>
						<label className='flex items-center gap-1.5 text-[13px]'>
							<input
								type='checkbox'
								className='!w-auto'
								checked={https}
								onChange={event => setHttps(event.target.checked)}
							/>
							Enable HTTPS
						</label>
						<label className='flex items-center gap-1.5 text-[13px]'>
							<input
								type='checkbox'
								className='!w-auto'
								checked={redirect}
								disabled={!https}
								onChange={event => setRedirect(event.target.checked)}
							/>
							Redirect HTTP to HTTPS
						</label>
					</div>
					{https ? (
						<div className='md:col-span-4'>
							<div className='mb-3 flex flex-wrap gap-4'>
								{(['letsencrypt', 'custom'] as const).map(option => (
									<label key={option} className='flex items-center gap-1.5 text-[13px]'>
										<input
											type='radio'
											name='certificate-source'
											className='!w-auto'
											checked={source === option}
											onChange={() => setSource(option)}
										/>
										{option === 'letsencrypt'
											? "Let's Encrypt, issued and renewed automatically"
											: 'Upload my own certificate'}
									</label>
								))}
							</div>
							{source === 'custom' ? (
								<div className='grid gap-x-6 md:grid-cols-2'>
									<Field
										label='Certificate'
										hint='Full chain in PEM: the leaf first, then any intermediates.'
									>
										<textarea
											rows={7}
											required
											spellCheck={false}
											placeholder='-----BEGIN CERTIFICATE-----'
											value={certPem}
											onChange={event => setCertPem(event.target.value)}
											className='font-mono text-[12px]'
										/>
									</Field>
									<Field
										label='Private key'
										hint='Never leaves this server. Stored with 0600 permissions.'
									>
										<textarea
											rows={7}
											required
											spellCheck={false}
											placeholder='-----BEGIN PRIVATE KEY-----'
											value={keyPem}
											onChange={event => setKeyPem(event.target.value)}
											className='font-mono text-[12px]'
										/>
									</Field>
								</div>
							) : null}
						</div>
					) : null}

					<div className='md:col-span-4'>
						<ErrorText error={create.error} />
						{warning ? <p className='pb-2 text-[13px] text-amber-400'>{warning}</p> : null}
						<Button type='submit' variant='primary' disabled={create.isPending}>
							{create.isPending ? 'Adding…' : 'Add domain'}
						</Button>
					</div>
				</form>
			</Section>
		</>
	)
}
