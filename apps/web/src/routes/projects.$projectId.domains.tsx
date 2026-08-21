import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, Check, ErrorText, Field, Refresh, Section, Status } from '../components/primitives'
import { api, type Certificate, type CertificateSource, type Domain } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'

type DomainTableDeps = {
	certificateFor: (domainId: string) => Certificate | undefined
	serviceName: (serviceId: string | null) => string
	renew: (domainId: string) => void
	renewing: boolean
	replace: (domain: Domain) => void
	remove: (domainId: string) => void
	toggleAnalytics: (domain: Domain) => void
}

function domainTableColumns({
	certificateFor,
	serviceName,
	renew,
	renewing,
	replace,
	remove,
	toggleAnalytics,
}: DomainTableDeps): Columns<Domain> {
	const cell = columnsFor<Domain>()
	return [
		cell.accessor(domain => domain.hostname, {
			id: 'hostname',
			header: 'Domain',
			meta: { mono: true },
			cell: ({ row: { original } }) => (
				<a
					href={`${original.https_enabled ? 'https' : 'http'}://${original.hostname}`}
					target='_blank'
					rel='noreferrer'
					className='hover:underline'
				>
					{original.hostname}
				</a>
			),
		}),
		cell.accessor(domain => serviceName(domain.service_id), {
			id: 'service',
			header: 'Service',
			meta: { mono: true },
		}),
		cell.accessor(domain => domain.container_port, { id: 'port', header: 'Port', meta: { mono: true } }),
		cell.accessor(domain => (domain.https_enabled ? 'on' : 'off'), { id: 'https', header: 'HTTPS' }),
		cell.accessor(domain => (domain.certificate_source === 'custom' ? 'uploaded' : "Let's Encrypt"), {
			id: 'source',
			header: 'Source',
		}),
		cell.accessor(domain => (domain.analytics ? 'on' : 'off'), {
			id: 'analytics',
			header: 'Analytics',
			cell: ({ row: { original } }) => (
				<Button variant='ghost' onClick={() => toggleAnalytics(original)}>
					{original.analytics ? 'on' : 'off'}
				</Button>
			),
		}),
		cell.accessor(domain => certificateFor(domain.id)?.status ?? 'none', {
			id: 'certificate',
			header: 'Certificate',
			cell: ({ row }) => {
				const certificate = certificateFor(row.original.id)
				if (!certificate) return <span className='text-muted-foreground'>none</span>
				return (
					<span className='flex items-center gap-2'>
						<Status value={certificate.status} />
						{certificate.expires_at ? (
							<span className='text-label text-muted-foreground'>
								until {certificate.expires_at.slice(0, 10)}
							</span>
						) : null}
					</span>
				)
			},
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row: { original } }) => (
				<span className='flex justify-end gap-1.5'>
					{original.https_enabled && original.certificate_source !== 'custom' ? (
						<Button variant='ghost' onClick={() => renew(original.id)} disabled={renewing}>
							renew
						</Button>
					) : null}
					{original.certificate_source === 'custom' ? (
						<Button variant='ghost' onClick={() => replace(original)}>
							replace certificate
						</Button>
					) : null}
					<Button variant='ghost' onClick={() => remove(original.id)}>
						remove
					</Button>
				</span>
			),
		}),
	]
}

export const Route = createFileRoute('/projects/$projectId/domains')({ component: ProjectDomains })

function ProjectDomains() {
	const { projectId } = Route.useParams()
	const queryClient = useQueryClient()
	const [warning, setWarning] = useState('')

	const domains = useQuery({ queryKey: ['domains', projectId], queryFn: () => api.projectDomains(projectId) })
	const environmentId = useEnvironmentId()
	const services = useQuery({
		queryKey: ['services', projectId, environmentId],
		queryFn: () => api.services(projectId, environmentId),
	})
	const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })

	const [hostname, setHostname] = useState('')
	const [service, setService] = useState('')
	const [port, setPort] = useState(3000)
	const [https, setHttps] = useState(true)
	const [redirect, setRedirect] = useState(true)
	const [source, setSource] = useState<CertificateSource>('letsencrypt')
	const [certPem, setCertPem] = useState('')
	const [keyPem, setKeyPem] = useState('')
	const [analytics, setAnalytics] = useState(false)
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
				environment_id: environmentId,
				service,
				hostname,
				container_port: port,
				https_enabled: https,
				redirect_https: redirect,
				certificate_source: source,
				certificate_pem: source === 'custom' ? certPem : undefined,
				private_key_pem: source === 'custom' ? keyPem : undefined,
				analytics,
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

	const tracking = useMutation({
		mutationFn: (domain: Domain) => api.updateDomain(domain.id, { analytics: !domain.analytics }),
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

	const { mutate: issueCertificate, isPending: issuing } = issue
	const { mutate: removeDomain } = remove
	const { mutate: toggleAnalytics } = tracking
	const { data: serviceList } = services
	const { data: certificateList } = certificates
	const columns = useMemo(
		() =>
			domainTableColumns({
				certificateFor: domainId => certificateList?.find(cert => cert.domain_id === domainId),
				serviceName: serviceId => serviceList?.find(item => item.id === serviceId)?.compose_service_name ?? '-',
				renew: issueCertificate,
				renewing: issuing,
				replace: setReplacing,
				remove: removeDomain,
				toggleAnalytics,
			}),
		[certificateList, serviceList, issueCertificate, issuing, removeDomain, toggleAnalytics],
	)

	return (
		<>
			<Section
				title='Domains'
				description='the platform generates and reloads Nginx for you'
				actions={<Refresh onClick={() => domains.refetch()} busy={domains.isFetching} />}
			>
				<DataTable
					data={domains.data ?? []}
					columns={columns}
					loading={domains.isLoading}
					getRowId={domain => domain.id}
					empty='No domains yet. Point an A record at this server, then add it below.'
				/>
				<ErrorText error={remove.error ?? issue.error ?? tracking.error} />
				{certificates.data?.some(cert => cert.status === 'failed') ? (
					<p className='pt-2 text-body text-amber-400'>
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
								className='font-mono text-label'
							/>
						</Field>
						<Field label='Private key'>
							<textarea
								rows={7}
								required
								spellCheck={false}
								value={replaceKey}
								onChange={event => setReplaceKey(event.target.value)}
								className='font-mono text-label'
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
					<Field label='Domain' hint='*.example.com needs a Cloudflare token in system settings.'>
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
						<Check label='Enable HTTPS' checked={https} onChange={setHttps} />
						<Check
							label='Redirect HTTP to HTTPS'
							checked={redirect}
							disabled={!https}
							onChange={setRedirect}
						/>
						<Check label='Collect analytics' checked={analytics} onChange={setAnalytics} />
					</div>
					{https ? (
						<div className='md:col-span-4'>
							<div className='mb-3 flex flex-wrap gap-4'>
								{(['letsencrypt', 'custom'] as const).map(option => (
									<label key={option} className='flex items-center gap-1.5 text-body'>
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
											className='font-mono text-label'
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
											className='font-mono text-label'
										/>
									</Field>
								</div>
							) : null}
						</div>
					) : null}

					<div className='md:col-span-4'>
						<ErrorText error={create.error} />
						{warning ? <p className='pb-2 text-body text-amber-400'>{warning}</p> : null}
						<Button type='submit' variant='primary' disabled={create.isPending}>
							{create.isPending ? 'Adding…' : 'Add domain'}
						</Button>
					</div>
				</form>
			</Section>
		</>
	)
}
