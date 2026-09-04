import { useMemo } from 'react'
import { IconExternalLink, IconWorld } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section, Status } from '../components/primitives'
import { api, type Certificate, type Domain } from '../lib/api'

/** A domain joined with the two lookups the table renders alongside it. */
type DomainRow = { domain: Domain; projectName: string; certificate: Certificate | undefined }

function domainTableColumns(): Columns<DomainRow> {
	const cell = columnsFor<DomainRow>()
	return [
		cell.accessor(row => row.domain.hostname, {
			id: 'hostname',
			header: 'Domain',
			cell: ({ row: { original } }) => (
				<a
					href={`${original.domain.https_enabled ? 'https' : 'http'}://${original.domain.hostname}`}
					target='_blank'
					rel='noreferrer'
					className='group inline-flex items-center gap-2 underline-offset-4 hover:underline'
				>
					<IconWorld className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{original.domain.hostname}</span>
					<IconExternalLink className='size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100' />
				</a>
			),
		}),
		cell.accessor(row => row.projectName, {
			id: 'project',
			header: 'Project',
			cell: ({ row: { original } }) => (
				<Link
					to='/projects/$projectId/domains'
					params={{ projectId: original.domain.project_id }}
					className='underline-offset-4 hover:underline'
				>
					{original.projectName}
				</Link>
			),
		}),
		cell.accessor(row => row.domain.container_port, { id: 'port', header: 'Port', meta: { mono: true } }),
		cell.accessor(row => (row.domain.https_enabled ? 'on' : 'off'), { id: 'https', header: 'HTTPS' }),
		cell.accessor(row => row.certificate?.status ?? 'none', {
			id: 'certificate',
			header: 'Certificate',
			cell: ({ row: { original } }) =>
				original.certificate ? (
					<Status value={original.certificate.status} />
				) : (
					<span className='text-muted-foreground'>none</span>
				),
		}),
		cell.accessor(row => row.certificate?.expires_at ?? '', {
			id: 'expires',
			header: 'Expires',
			cell: ({ row: { original } }) => (
				<span className='text-muted-foreground'>
					{original.certificate?.expires_at ? original.certificate.expires_at.slice(0, 10) : '-'}
				</span>
			),
			meta: { mono: true },
		}),
	]
}

export const Route = createFileRoute('/domains')({ component: DomainsPage })

function DomainsPage() {
	const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
	const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })

	const data = useMemo<DomainRow[]>(
		() =>
			domains.data?.map(domain => ({
				domain,
				projectName: projects.data?.find(item => item.id === domain.project_id)?.name ?? domain.project_id,
				certificate: certificates.data?.find(item => item.domain_id === domain.id),
			})) ?? [],
		[domains.data, projects.data, certificates.data],
	)
	const columns = useMemo(domainTableColumns, [])

	return (
		<Page>
			<Section
				title='All domains'
				description='add and edit them inside a project'
				actions={<Refresh onClick={() => domains.refetch()} busy={domains.isFetching} />}
			>
				<DataTable
					data={data}
					columns={columns}
					loading={domains.isLoading}
					getRowId={({ domain }) => domain.id}
					filter='Filter domains'
					empty='No domains configured yet'
				/>
			</Section>
		</Page>
	)
}
