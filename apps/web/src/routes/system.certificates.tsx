import { useState } from 'react'
import { IconCertificate, IconUpload } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import {
	Button,
	ErrorText,
	Field,
	FormSection,
	IconButton,
	Page,
	Refresh,
	Section,
	Select,
	Status,
	Textarea,
} from '../components/primitives'
import { api, type Certificate, type Domain } from '../lib/api'

function certificateTableColumns(replace: (hostname: string) => void): Columns<Certificate> {
	const cell = columnsFor<Certificate>()
	return [
		cell.accessor(row => row.hostname, {
			id: 'hostname',
			header: 'Domain',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconCertificate className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{row.original.hostname}</span>
				</span>
			),
		}),
		cell.accessor(row => row.issuer || '-', { id: 'issuer', header: 'Issuer' }),
		cell.accessor(row => row.status, {
			id: 'status',
			header: 'Status',
			cell: ({ row }) => <Status value={row.original.status} />,
		}),
		cell.accessor(row => row.expires_at ?? '', {
			id: 'expires',
			header: 'Expires',
			meta: { mono: true },
			cell: ({ row }) => (
				<span className='text-muted-foreground'>
					{row.original.expires_at ? row.original.expires_at.slice(0, 10) : '-'}
				</span>
			),
		}),
		cell.display({
			id: 'actions',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<IconButton
					icon={IconUpload}
					label='Replace certificate'
					onClick={() => replace(row.original.hostname)}
				/>
			),
		}),
	]
}

export const Route = createFileRoute('/system/certificates')({ component: Certificates })

function Certificates() {
	const queryClient = useQueryClient()
	const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })
	const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
	const [uploading, setUploading] = useState(false)
	const [hostname, setHostname] = useState('')
	const [certPem, setCertPem] = useState('')
	const [keyPem, setKeyPem] = useState('')

	const options = (domains.data ?? []).map(domain => ({ value: domain.hostname, label: domain.hostname }))
	const install = useMutation({
		mutationFn: (domain: Domain) =>
			api.updateDomain(domain.id, {
				https_enabled: true,
				certificate_source: 'custom',
				certificate_pem: certPem,
				private_key_pem: keyPem,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['certificates'] })
			setUploading(false)
			setCertPem('')
			setKeyPem('')
		},
	})

	const openUpload = (preset: string) => {
		setHostname(preset)
		setCertPem('')
		setKeyPem('')
		install.reset()
		setUploading(true)
	}
	const columns = certificateTableColumns(openUpload)
	const rows = (certificates.data ?? []).filter(certificate => certificate.source === 'custom')

	return (
		<Page>
			<Section
				title='Certificates'
				description={`${rows.length} uploaded`}
				actions={
					<>
						<Refresh onClick={() => certificates.refetch()} busy={certificates.isFetching} />
						<Button
							variant='primary'
							onClick={() => openUpload(hostname || (options[0]?.value ?? ''))}
							disabled={options.length === 0}
						>
							<IconUpload />
							Add certificate
						</Button>
					</>
				}
			>
				<DataTable
					data={rows}
					columns={columns}
					loading={certificates.isLoading}
					getRowId={row => row.id}
					filter='Filter certificates'
					empty="No certificates uploaded. Let's Encrypt certificates live on each project's Domains tab."
				/>
			</Section>

			{uploading ? (
				<FormSection
					title='Add certificate'
					description='Full chain in PEM: the leaf first, then any intermediates.'
					icon={IconCertificate}
					hint='The private key never leaves this server.'
					actions={
						<>
							<Button variant='ghost' onClick={() => setUploading(false)}>
								Cancel
							</Button>
							<Button type='submit' variant='primary' disabled={install.isPending}>
								<IconUpload />
								{install.isPending ? 'Installing…' : 'Install certificate'}
							</Button>
						</>
					}
					onSave={() => {
						const domain = domains.data?.find(candidate => candidate.hostname === hostname)
						if (domain) install.mutate(domain)
					}}
				>
					<ErrorText error={install.error} />
					<Field label='Domain' hint='Uploading switches this domain to your certificate and enables HTTPS.'>
						<Select value={hostname} options={options} onChange={setHostname} required />
					</Field>
					<div className='grid gap-x-6 md:grid-cols-2'>
						<Field label='Certificate'>
							<Textarea
								rows={7}
								required
								spellCheck={false}
								placeholder='-----BEGIN CERTIFICATE-----'
								value={certPem}
								onChange={event => setCertPem(event.target.value)}
							/>
						</Field>
						<Field label='Private key'>
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
				</FormSection>
			) : null}
		</Page>
	)
}
