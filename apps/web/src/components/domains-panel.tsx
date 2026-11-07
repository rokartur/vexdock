import { type ReactNode, useState } from 'react'
import {
	IconAlertCircle,
	IconCertificate,
	IconCircleDashed,
	IconExternalLink,
	IconLock,
	IconPlus,
	IconProgress,
	IconRefresh,
	IconTrash,
	IconUpload,
	IconWorld,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import { Alert } from '@/components/ui/alert'
import { api, type Certificate, certificateStatus, type CertificateSource, type Domain, type Service } from '../lib/api'
import { certificatesQuery, projectDomainsQuery } from '../lib/queries'
import {
	Announcement,
	Button,
	Confirm,
	EmptyState,
	ErrorText,
	ListPlaceholder,
	Field,
	FormDialog,
	IconButton,
	Input,
	NumberField,
	Refresh,
	RelativeTime,
	Section,
	Segmented,
	Switch,
	Textarea,
	textLink,
} from './primitives'

const certificateSources = [
	{ value: 'letsencrypt', label: "Let's Encrypt", icon: IconLock },
	{ value: 'custom', label: 'Upload my own', icon: IconUpload },
] as const satisfies readonly { value: CertificateSource; label: string; icon: unknown }[]

const statusIcon = { size: 16, stroke: 1.75, 'aria-hidden': true, className: 'flex-none' } as const

function CertificateState({ domain, certificates }: { domain: Domain; certificates: Certificate[] | undefined }) {
	if (!domain.https_enabled)
		return <StateLabel icon={<IconCircleDashed {...statusIcon} />} label='HTTP only' className='text-muted' />
	// Until the list loads (or when it failed) a missing certificate says nothing, not "Issuing".
	if (!certificates) return null
	const certificate = certificates.find(cert => cert.domain_id === domain.id)
	if (!certificate || certificate.status === 'pending')
		return <StateLabel icon={<IconProgress {...statusIcon} />} label='Issuing' />
	if (certificate.status === 'failed')
		return <StateLabel icon={<IconAlertCircle {...statusIcon} />} label='Failed' className='*:[svg]:text-danger' />
	if (certificateStatus(certificate) === 'expired')
		return (
			<StateLabel
				icon={<IconAlertCircle {...statusIcon} />}
				label={
					<>
						Expired <RelativeTime at={certificate.expires_at} />
					</>
				}
				className='text-danger *:[svg]:text-danger'
			/>
		)
	return (
		<StateLabel
			icon={<IconLock {...statusIcon} />}
			label={
				<>
					Expires <RelativeTime at={certificate.expires_at} future />
				</>
			}
			className='*:[svg]:text-success'
		/>
	)
}

function StateLabel({ icon, label, className }: { icon: ReactNode; label: ReactNode; className?: string }) {
	return (
		<span
			className={cn('inline-flex items-center gap-1.5 text-sm whitespace-nowrap *:[svg]:text-muted', className)}
		>
			{icon}
			<span>{label}</span>
		</span>
	)
}

function DomainRow({
	domain,
	certificates,
	renew,
	renewingId,
	replace,
	remove,
	removingId,
}: {
	domain: Domain
	certificates: Certificate[] | undefined
	renew: (domainId: string) => void
	/** The domain a renewal is in flight for: one at a time, so its row keeps the spinner. */
	renewingId: string | undefined
	replace: (domain: Domain) => void
	remove: (domainId: string) => void
	removingId: string | undefined
}) {
	const source = domain.certificate_source === 'custom' ? ', uploaded certificate' : ", Let's Encrypt"
	return (
		<li className='grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-5 py-3 not-first:border-t not-first:border-border-subtle max-sm:px-4 sm:grid-cols-[16px_minmax(0,1fr)_auto_auto]'>
			<IconWorld className='size-4 text-muted' stroke={1.75} />
			<div className='grid min-w-0 gap-0.5'>
				{/* A wildcard names many sites, so there is no single one to open. */}
				{domain.hostname.startsWith('*.') ? (
					<span className='min-w-0 font-medium wrap-anywhere'>{domain.hostname}</span>
				) : (
					<a
						href={`${domain.https_enabled ? 'https' : 'http'}://${domain.hostname}`}
						target='_blank'
						rel='noreferrer'
						className={cn(textLink, 'group inline-flex min-w-0 items-center gap-1.5 font-medium')}
					>
						<span className='min-w-0 wrap-anywhere'>{domain.hostname}</span>
						<IconExternalLink
							aria-hidden
							stroke={1.75}
							className='size-3 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100'
						/>
						<span className='sr-only'> (opens in a new tab)</span>
					</a>
				)}
				<span className='text-xs text-muted'>
					port <span className='font-mono'>{domain.container_port}</span>
					{domain.https_enabled ? source : null}
				</span>
			</div>
			<span className='col-start-2 row-start-2 sm:col-start-auto sm:row-start-auto'>
				<CertificateState domain={domain} certificates={certificates} />
			</span>
			<span className='col-start-3 row-span-2 row-start-1 flex justify-end gap-0.5 sm:col-start-auto sm:row-span-1'>
				{domain.https_enabled && domain.certificate_source !== 'custom' ? (
					<IconButton
						icon={IconRefresh}
						label={`Renew the certificate for ${domain.hostname}`}
						onClick={() => renew(domain.id)}
						loading={renewingId === domain.id}
						disabled={renewingId !== undefined}
					/>
				) : null}
				{domain.https_enabled && domain.certificate_source === 'custom' ? (
					<IconButton
						icon={IconCertificate}
						label={`Replace the certificate for ${domain.hostname}`}
						onClick={() => replace(domain)}
					/>
				) : null}
				<Confirm
					title={`Remove ${domain.hostname}?`}
					description='Nginx stops answering for it. Its certificate is kept until it expires.'
					action='Remove domain'
					onConfirm={() => remove(domain.id)}
				>
					<IconButton
						icon={IconTrash}
						label={`Remove ${domain.hostname}`}
						loading={removingId === domain.id}
						disabled={removingId !== undefined}
					/>
				</Confirm>
			</span>
		</li>
	)
}

export function DomainsPanel({ projectId, service }: { projectId: string; service: Service }) {
	const queryClient = useQueryClient()
	const [warning, setWarning] = useState('')

	const domains = useQuery(projectDomainsQuery(projectId))
	const certificates = useQuery(certificatesQuery)

	const [adding, setAdding] = useState(false)
	const [hostname, setHostname] = useState('')
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
				environment_id: service.environment_id,
				service: service.compose_service_name,
				hostname,
				container_port: port,
				https_enabled: https,
				redirect_https: https && redirect,
				certificate_source: https ? source : 'letsencrypt',
				certificate_pem: https && source === 'custom' ? certPem : undefined,
				private_key_pem: https && source === 'custom' ? keyPem : undefined,
			}),
		onSuccess: async result => {
			setWarning(result.warning ?? '')
			setHostname('')
			setCertPem('')
			setKeyPem('')
			setAdding(false)
			await invalidate()
		},
	})

	const remove = useMutation({
		mutationFn: api.deleteDomain,
		onSuccess: invalidate,
	})

	// A renewal that lands changes only its row's state, so a screen reader hears it here.
	const [announced, setAnnounced] = useState({ text: '', at: 0 })
	// Domain id to the time its renewal last failed again; a renewal that lands clears its entry.
	const [retried, setRetried] = useState<Record<string, string>>({})
	const issue = useMutation({
		mutationFn: api.issueCertificate,
		onSuccess: (certificate, domainId) => {
			setRetried(previous => ({ ...previous, [domainId]: '' }))
			setAnnounced({ text: `Certificate for ${certificate.hostname}: ${certificate.status}`, at: Date.now() })
		},
		// A repeat failure hides the ErrorText below and leaves the failed alert's error as it was, so the alert's
		// "Tried again" line and this announcement are what say it ran.
		onError: (error, domainId) => {
			const again = certificates.data?.find(cert => cert.domain_id === domainId && cert.status === 'failed')
			if (!again) return
			setRetried(previous => ({ ...previous, [domainId]: new Date().toISOString() }))
			setAnnounced({
				text: `Could not renew the certificate for ${again.hostname}: ${error.message}`,
				at: Date.now(),
			})
		},
		// The manager records a failed issue before it answers 502, so the row has news either way.
		onSettled: invalidate,
	})

	const replace = useMutation({
		mutationFn: (id: string) =>
			api.updateDomain(id, {
				certificate_source: 'custom',
				certificate_pem: replaceCert,
				private_key_pem: replaceKey,
			}),
		onSuccess: async () => {
			closeReplace()
			await invalidate()
		},
	})

	// The PEM pasted for one domain must not wait in the dialog opened for the next.
	function closeReplace() {
		setReplacing(null)
		setReplaceCert('')
		setReplaceKey('')
	}

	const { mutate: issueCertificate } = issue
	const { mutate: removeDomain } = remove
	const rows = (domains.data ?? []).filter(domain => domain.service_id === service.id)
	const failed = (certificates.data ?? []).filter(
		cert => cert.status === 'failed' && rows.some(domain => domain.id === cert.domain_id),
	)

	return (
		<>
			<Announcement message={announced} />
			<Section
				title='Domains'
				total={domains.data ? rows.length : undefined}
				actions={
					<>
						<Refresh onClick={() => Promise.all([domains.refetch(), certificates.refetch()])} />
						<Button variant='primary' size='sm' onClick={() => setAdding(true)}>
							<IconPlus size={16} stroke={1.75} />
							Add domain
						</Button>
					</>
				}
			>
				<ErrorText error={domains.error} />
				<ErrorText error={certificates.error} />
				<ErrorText error={remove.error} />
				{/* Once the refetch lands, a recorded failure is the alert below with its Renew; this one would repeat it. */}
				<ErrorText error={failed.some(cert => cert.domain_id === issue.variables) ? null : issue.error} />
				<Alert
					open={warning !== ''}
					onDismiss={() => setWarning('')}
					tone='warning'
					title={warning}
					className='mb-3'
				/>
				{failed.map(cert => (
					<Alert
						key={cert.id}
						tone='danger'
						title={`Could not issue a certificate for ${cert.hostname}`}
						className='mb-3'
					>
						<span className='block'>{cert.last_error}</span>
						<span className='block'>Check that its A record points at this server, then renew.</span>
						{retried[cert.domain_id] ? (
							<span className='block'>
								Tried again <RelativeTime at={retried[cert.domain_id]} />
							</span>
						) : null}
						<span className='mt-2 flex'>
							<Button
								loading={issue.isPending && issue.variables === cert.domain_id}
								disabled={issue.isPending}
								onClick={() => issueCertificate(cert.domain_id)}
							>
								<IconRefresh size={16} stroke={1.75} />
								Renew certificate
							</Button>
						</span>
					</Alert>
				))}
				{rows.length > 0 ? (
					<ul className='rounded-surface border bg-surface'>
						{rows.map(domain => (
							<DomainRow
								key={domain.id}
								domain={domain}
								certificates={certificates.data}
								renew={issueCertificate}
								renewingId={issue.isPending ? issue.variables : undefined}
								replace={setReplacing}
								remove={removeDomain}
								removingId={remove.isPending ? remove.variables : undefined}
							/>
						))}
					</ul>
				) : domains.error ? null : (
					<ListPlaceholder loading={domains.isLoading} label='Loading domains'>
						<EmptyState
							icon={IconWorld}
							title='No domains yet'
							description='Point an A record at this server, then add it with Add domain.'
						/>
					</ListPlaceholder>
				)}
			</Section>

			<FormDialog
				open={replacing !== null}
				onOpenChange={open => {
					if (!open) closeReplace()
				}}
				title={replacing ? `Replace the certificate for ${replacing.hostname}` : 'Replace certificate'}
				description='Full chain in PEM: the leaf first, then any intermediates. The private key never leaves this server.'
				action='Replace certificate'
				icon={IconUpload}
				mutation={replace}
				wide
				onSubmit={() => {
					if (replacing) replace.mutate(replacing.id)
				}}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Certificate chain'>
						<Textarea
							mono
							rows={7}
							required
							value={replaceCert}
							onChange={event => setReplaceCert(event.target.value)}
						/>
					</Field>
					<Field label='Private key'>
						<Textarea
							mono
							rows={7}
							required
							value={replaceKey}
							onChange={event => setReplaceKey(event.target.value)}
						/>
					</Field>
				</div>
			</FormDialog>

			<FormDialog
				open={adding}
				onOpenChange={open => {
					setAdding(open)
					if (open) return
					setCertPem('')
					setKeyPem('')
				}}
				title='Add domain'
				description='Point an A record at this server first. *.example.com needs a Cloudflare token in system settings.'
				action='Add domain'
				icon={IconPlus}
				mutation={create}
				wide
				onSubmit={() => create.mutate()}
			>
				<div className='grid gap-x-6 md:grid-cols-3'>
					<Field label='Domain'>
						<Input
							mono
							required
							placeholder='app.example.com'
							value={hostname}
							onChange={event => setHostname(event.target.value)}
						/>
					</Field>
					<Field label='Container port'>
						<NumberField min={1} max={65_535} value={port} onValueChange={setPort} />
					</Field>
					<div className='flex flex-col justify-center gap-2 pb-3'>
						<Switch label='Enable HTTPS' checked={https} onChange={setHttps} />
						<Switch
							label='Redirect HTTP to HTTPS'
							checked={https && redirect}
							disabled={!https}
							onChange={setRedirect}
						/>
					</div>
				</div>
				{https ? (
					<>
						<Field
							label='Certificate'
							hint={source === 'letsencrypt' ? 'Issued and renewed automatically.' : undefined}
						>
							<Segmented
								label='Certificate source'
								value={source}
								onChange={setSource}
								options={certificateSources}
							/>
						</Field>
						{source === 'custom' ? (
							<div className='grid gap-x-6 md:grid-cols-2'>
								<Field
									label='Certificate chain'
									hint='Full chain in PEM: the leaf first, then any intermediates.'
								>
									<Textarea
										mono
										rows={7}
										required
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
										mono
										rows={7}
										required
										placeholder='-----BEGIN PRIVATE KEY-----'
										value={keyPem}
										onChange={event => setKeyPem(event.target.value)}
									/>
								</Field>
							</div>
						) : null}
					</>
				) : null}
			</FormDialog>
		</>
	)
}
