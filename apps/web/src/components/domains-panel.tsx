import { useMemo, useState } from 'react'
import {
	IconAlertTriangle,
	IconCertificate,
	IconChartBar,
	IconChartBarOff,
	IconExternalLink,
	IconLock,
	IconPlus,
	IconRefresh,
	IconTrash,
	IconUpload,
	IconWorld,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { api, type Certificate, type CertificateSource, type Domain, type Service } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { cn } from '../utils/cn'
import { type Columns, DataTable, columnsFor } from './data-table'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormSection,
	IconButton,
	Input,
	Refresh,
	Section,
	Segmented,
	Select,
	Status,
	Switch,
	Textarea,
} from './primitives'

const certificateSources = [
	{ value: 'letsencrypt', label: "Let's Encrypt", icon: IconLock },
	{ value: 'custom', label: 'Upload my own', icon: IconUpload },
] as const satisfies readonly { value: CertificateSource; label: string; icon: unknown }[]

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
			cell: ({ row: { original } }) => (
				<a
					href={`${original.https_enabled ? 'https' : 'http'}://${original.hostname}`}
					target='_blank'
					rel='noreferrer'
					className='group inline-flex items-center gap-2 underline-offset-4 hover:underline'
				>
					<IconWorld className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{original.hostname}</span>
					<IconExternalLink className='size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100' />
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
				<IconButton
					icon={original.analytics ? IconChartBar : IconChartBarOff}
					label={original.analytics ? 'Analytics on. Turn off' : 'Analytics off. Turn on'}
					aria-pressed={original.analytics}
					onClick={() => toggleAnalytics(original)}
				/>
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
				<span className='flex justify-end gap-0.5'>
					{original.https_enabled && original.certificate_source !== 'custom' ? (
						<IconButton
							icon={IconRefresh}
							label='Renew certificate'
							onClick={() => renew(original.id)}
							disabled={renewing}
						/>
					) : null}
					{original.certificate_source === 'custom' ? (
						<IconButton
							icon={IconCertificate}
							label='Replace certificate'
							onClick={() => replace(original)}
						/>
					) : null}
					<Confirm
						title={`Remove ${original.hostname}?`}
						description='Nginx stops answering for it. Its certificate is kept until it expires.'
						action='Remove'
						onConfirm={() => remove(original.id)}
					>
						<IconButton icon={IconTrash} label='Remove' />
					</Confirm>
				</span>
			),
		}),
	]
}

/**
 * The project's domains and the form that adds one. Given a service it shows
 * only that service's hostnames and adds new ones to it, so the service column
 * and picker have nothing left to say.
 */
export function DomainsPanel({ projectId, scope }: { projectId: string; scope?: Service }) {
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
	const [service, setService] = useState(scope?.compose_service_name ?? '')
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
			}).filter(column => !scope || column.id !== 'service'),
		[certificateList, serviceList, issueCertificate, issuing, removeDomain, toggleAnalytics, scope],
	)
	const rows = (domains.data ?? []).filter(domain => !scope || domain.service_id === scope.id)

	return (
		<>
			<Section
				title='Domains'
				description='the platform generates and reloads Nginx for you'
				actions={<Refresh onClick={() => domains.refetch()} busy={domains.isFetching} />}
			>
				<ErrorText error={remove.error ?? issue.error ?? tracking.error} />
				{certificates.data?.some(cert => cert.status === 'failed') ? (
					<Alert className='mb-3'>
						<IconAlertTriangle className='text-amber-400' />
						<AlertDescription>
							{certificates.data.find(cert => cert.status === 'failed')?.last_error}
						</AlertDescription>
					</Alert>
				) : null}
				<DataTable
					data={rows}
					columns={columns}
					loading={domains.isLoading}
					getRowId={domain => domain.id}
					empty='No domains yet. Point an A record at this server, then add it below.'
				/>
			</Section>

			{replacing ? (
				<FormSection
					title={`Replace the certificate for ${replacing.hostname}`}
					description='Full chain in PEM: the leaf first, then any intermediates.'
					icon={IconCertificate}
					hint='The private key never leaves this server.'
					actions={
						<>
							<Button variant='ghost' onClick={() => setReplacing(null)}>
								Cancel
							</Button>
							<Button type='submit' variant='primary' disabled={replace.isPending}>
								<IconUpload />
								{replace.isPending ? 'Installing…' : 'Install certificate'}
							</Button>
						</>
					}
					onSave={() => replace.mutate(replacing.id)}
				>
					<ErrorText error={replace.error} />
					<div className='grid gap-x-6 md:grid-cols-2'>
						<Field label='Certificate'>
							<Textarea
								rows={7}
								required
								spellCheck={false}
								value={replaceCert}
								onChange={event => setReplaceCert(event.target.value)}
							/>
						</Field>
						<Field label='Private key'>
							<Textarea
								rows={7}
								required
								spellCheck={false}
								value={replaceKey}
								onChange={event => setReplaceKey(event.target.value)}
							/>
						</Field>
					</div>
				</FormSection>
			) : null}

			<FormSection
				title='Add domain'
				description='Point an A record at this server first.'
				icon={IconWorld}
				hint='*.example.com needs a Cloudflare token in system settings.'
				actions={
					<Button type='submit' variant='primary' disabled={create.isPending}>
						<IconPlus />
						{create.isPending ? 'Adding…' : 'Add domain'}
					</Button>
				}
				onSave={() => create.mutate()}
			>
				<ErrorText error={create.error} />
				{warning ? (
					<Alert className='mb-3'>
						<IconAlertTriangle className='text-amber-400' />
						<AlertDescription>{warning}</AlertDescription>
					</Alert>
				) : null}
				<div className={cn('grid gap-x-6', scope ? 'md:grid-cols-3' : 'md:grid-cols-4')}>
					<Field label='Domain'>
						<Input
							required
							placeholder='app.example.com'
							value={hostname}
							onChange={event => setHostname(event.target.value)}
						/>
					</Field>
					{scope ? null : (
						<Field label='Service'>
							<Select
								required
								value={service}
								onChange={setService}
								options={[
									{ value: '', label: 'Select…' },
									...(services.data ?? []).map(item => ({
										value: item.compose_service_name,
										label: item.compose_service_name,
									})),
								]}
							/>
						</Field>
					)}
					<Field label='Container port'>
						<Input
							type='number'
							required
							min={1}
							max={65_535}
							value={port}
							onChange={event => setPort(Number(event.target.value))}
						/>
					</Field>
					<div className='flex flex-col justify-center gap-2 pb-3'>
						<Switch label='Enable HTTPS' checked={https} onChange={setHttps} />
						<Switch
							label='Redirect HTTP to HTTPS'
							checked={redirect}
							disabled={!https}
							onChange={setRedirect}
						/>
						<Switch label='Collect analytics' checked={analytics} onChange={setAnalytics} />
					</div>
				</div>
				{https ? (
					<>
						<Field
							label='Certificate'
							hint={source === 'letsencrypt' ? 'Issued and renewed automatically.' : undefined}
						>
							<Segmented value={source} onChange={setSource} options={certificateSources} />
						</Field>
						{source === 'custom' ? (
							<div className='grid gap-x-6 md:grid-cols-2'>
								<Field
									label='Certificate'
									hint='Full chain in PEM: the leaf first, then any intermediates.'
								>
									<Textarea
										rows={7}
										required
										spellCheck={false}
										placeholder='-----BEGIN CERTIFICATE-----'
										value={certPem}
										onChange={event => setCertPem(event.target.value)}
									/>
								</Field>
								<Field
									label='Private key'
									hint='Never leaves this server. Stored with 0600 permissions.'
								>
									<Textarea
										rows={7}
										required
										spellCheck={false}
										placeholder='-----BEGIN PRIVATE KEY-----'
										value={keyPem}
										onChange={event => setKeyPem(event.target.value)}
									/>
								</Field>
							</div>
						) : null}
					</>
				) : null}
			</FormSection>
		</>
	)
}
