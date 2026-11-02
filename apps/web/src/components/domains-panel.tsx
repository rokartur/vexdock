import { type ReactNode, useState } from 'react'
import {
	IconAlertCircle,
	IconCertificate,
	IconCircleDashed,
	IconExternalLink,
	IconLoader2,
	IconLock,
	IconPlus,
	IconRefresh,
	IconTrash,
	IconUpload,
	IconWorld,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import { Alert } from '@/components/ui/alert'
import { api, type Certificate, type CertificateSource, type Domain, type Service } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { certificatesQuery, projectDomainsQuery } from '../lib/queries'
import {
	Button,
	Confirm,
	EmptyState,
	ErrorText,
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
} from './primitives'

const certificateSources = [
	{ value: 'letsencrypt', label: "Let's Encrypt", icon: IconLock },
	{ value: 'custom', label: 'Upload my own', icon: IconUpload },
] as const satisfies readonly { value: CertificateSource; label: string; icon: unknown }[]

const statusIcon = { size: 16, stroke: 1.75, 'aria-hidden': true, className: 'flex-none' } as const

function CertificateState({ domain, certificate }: { domain: Domain; certificate: Certificate | undefined }) {
	if (!domain.https_enabled)
		return <StateLabel icon={<IconCircleDashed {...statusIcon} />} label='HTTP only' className='text-muted' />
	if (!certificate || certificate.status === 'pending')
		return (
			<StateLabel
				icon={<IconLoader2 {...statusIcon} className='flex-none animate-spin [animation-duration:630ms]' />}
				label='Issuing'
			/>
		)
	if (certificate.status === 'failed')
		return (
			<StateLabel
				icon={<IconAlertCircle {...statusIcon} />}
				label='Failed'
				className='*:[svg]:text-danger'
				title={certificate.last_error}
			/>
		)
	return (
		<StateLabel
			icon={<IconLock {...statusIcon} />}
			label={
				<>
					Expires <RelativeTime at={certificate.expires_at} />
				</>
			}
			className='*:[svg]:text-success'
		/>
	)
}

function StateLabel({
	icon,
	label,
	className,
	title,
}: {
	icon: ReactNode
	label: ReactNode
	className?: string
	title?: string
}) {
	return (
		<span
			title={title}
			className={cn('inline-flex items-center gap-1.5 text-sm whitespace-nowrap *:[svg]:text-muted', className)}
		>
			{icon}
			<span>{label}</span>
		</span>
	)
}

function DomainRow({
	domain,
	certificate,
	renew,
	renewing,
	replace,
	remove,
}: {
	domain: Domain
	certificate: Certificate | undefined
	renew: (domainId: string) => void
	renewing: boolean
	replace: (domain: Domain) => void
	remove: (domainId: string) => void
}) {
	const source = domain.certificate_source === 'custom' ? ', uploaded certificate' : ", Let's Encrypt"
	return (
		<li className='grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-5 py-3 not-first:border-t not-first:border-border-subtle max-sm:px-4 sm:grid-cols-[16px_minmax(0,1fr)_auto_auto]'>
			<IconWorld className='size-4 text-muted' stroke={1.75} />
			<div className='grid min-w-0 gap-0.5'>
				<a
					href={`${domain.https_enabled ? 'https' : 'http'}://${domain.hostname}`}
					target='_blank'
					rel='noreferrer'
					className='group inline-flex min-w-0 items-center gap-1.5 font-medium underline-offset-4 hover:underline'
				>
					<span className='truncate'>{domain.hostname}</span>
					<IconExternalLink className='size-3 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100' />
				</a>
				<span className='text-xs text-muted'>
					port <span className='font-mono'>{domain.container_port}</span>
					{domain.https_enabled ? source : null}
				</span>
			</div>
			<span className='col-start-2 row-start-2 sm:col-start-auto sm:row-start-auto'>
				<CertificateState domain={domain} certificate={certificate} />
			</span>
			<span className='col-start-3 row-span-2 row-start-1 flex justify-end gap-0.5 sm:col-start-auto sm:row-span-1'>
				{domain.https_enabled && domain.certificate_source !== 'custom' ? (
					<IconButton
						icon={IconRefresh}
						label='Renew certificate'
						onClick={() => renew(domain.id)}
						disabled={renewing}
					/>
				) : null}
				{domain.certificate_source === 'custom' ? (
					<IconButton icon={IconCertificate} label='Replace certificate' onClick={() => replace(domain)} />
				) : null}
				<Confirm
					title={`Remove ${domain.hostname}?`}
					description='Nginx stops answering for it. Its certificate is kept until it expires.'
					action='Remove'
					onConfirm={() => remove(domain.id)}
				>
					<IconButton icon={IconTrash} label='Remove' />
				</Confirm>
			</span>
		</li>
	)
}

export function DomainsPanel({ projectId, service }: { projectId: string; service: Service }) {
	const queryClient = useQueryClient()
	const [warning, setWarning] = useState('')

	const domains = useQuery(projectDomainsQuery(projectId))
	const environmentId = useEnvironmentId()
	const certificates = useQuery(certificatesQuery)
	const failedCertificate = certificates.data?.find(cert => cert.status === 'failed')

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
				environment_id: environmentId,
				service: service.compose_service_name,
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
			setAdding(false)
			await invalidate()
		},
	})

	const remove = useMutation({
		mutationFn: api.deleteDomain,
		onSuccess: invalidate,
	})

	const issue = useMutation({
		mutationFn: api.issueCertificate,
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
	const rows = (domains.data ?? []).filter(domain => domain.service_id === service.id)

	return (
		<>
			<Section
				title='Domains'
				actions={
					<>
						<Refresh onClick={() => domains.refetch()} busy={domains.isFetching} />
						<Button variant='primary' onClick={() => setAdding(true)}>
							<IconPlus />
							Add domain
						</Button>
					</>
				}
			>
				<ErrorText error={remove.error ?? issue.error ?? domains.error} />
				{warning ? <Alert tone='warning' title={warning} className='mb-3' /> : null}
				{failedCertificate ? (
					<Alert tone='warning' title={failedCertificate.last_error} className='mb-3' />
				) : null}
				{rows.length === 0 ? (
					<div className='rounded-surface border bg-surface'>
						<EmptyState
							icon={IconWorld}
							title={domains.isLoading ? 'Loading domains' : 'No domains yet'}
							description='Point an A record at this server, then add it.'
						/>
					</div>
				) : (
					<ul className='rounded-surface border bg-surface'>
						{rows.map(domain => (
							<DomainRow
								key={domain.id}
								domain={domain}
								certificate={certificates.data?.find(cert => cert.domain_id === domain.id)}
								renew={issueCertificate}
								renewing={issuing}
								replace={setReplacing}
								remove={removeDomain}
							/>
						))}
					</ul>
				)}
			</Section>

			<FormDialog
				open={replacing !== null}
				onOpenChange={open => {
					if (!open) setReplacing(null)
				}}
				title={replacing ? `Replace the certificate for ${replacing.hostname}` : 'Replace certificate'}
				description='Full chain in PEM: the leaf first, then any intermediates. The private key never leaves this server.'
				action={replace.isPending ? 'Installing…' : 'Install certificate'}
				icon={IconUpload}
				mutation={replace}
				wide
				onSubmit={() => {
					if (replacing) replace.mutate(replacing.id)
				}}
			>
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
			</FormDialog>

			<FormDialog
				open={adding}
				onOpenChange={setAdding}
				title='Add domain'
				description='Point an A record at this server first. *.example.com needs a Cloudflare token in system settings.'
				action={create.isPending ? 'Adding…' : 'Add domain'}
				icon={IconPlus}
				mutation={create}
				wide
				onSubmit={() => create.mutate()}
			>
				<div className='grid gap-x-6 md:grid-cols-3'>
					<Field label='Domain'>
						<Input
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
							checked={redirect}
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
			</FormDialog>
		</>
	)
}
