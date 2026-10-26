import { useMemo, useState } from 'react'
import { IconKey, IconPlus, IconTrash } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { AccessPicker } from '../components/access-picker'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormDialog,
	IconButton,
	Input,
	Refresh,
	RelativeTime,
	Section,
} from '../components/primitives'
import { type Access, grantList, picksNothing } from '../lib/access'
import { api, type ApiToken } from '../lib/api'
import { preload, projectsQuery } from '../lib/queries'

const tokensQuery = queryOptions({ queryKey: ['tokens'], queryFn: api.tokens })

const fullAccess: Access = { full: true, grants: {} }

export const Route = createFileRoute('/system/settings/tokens')({
	loader: ({ context: { queryClient } }) =>
		Promise.all([preload(queryClient, tokensQuery), preload(queryClient, projectsQuery)]),
	component: ApiTokens,
})

function TokenAccess({ token, projectName }: { token: ApiToken; projectName: (id: string) => string }) {
	if (token.admin) return <Badge tone='warning'>Full access</Badge>
	if (token.projects.length > 2) {
		const names = token.projects.map(grant => `${projectName(grant.project_id)}: ${grant.level}`).join(', ')
		return <Badge title={names}>{token.projects.length} projects</Badge>
	}
	return (
		<span className='inline-flex flex-wrap gap-1'>
			{token.projects.map(grant => (
				<Badge key={grant.project_id} tone={grant.level === 'write' ? 'success' : 'neutral'}>
					{projectName(grant.project_id)}: {grant.level}
				</Badge>
			))}
		</span>
	)
}

function tokenTableColumns(revoke: (id: string) => void, projectName: (id: string) => string): Columns<ApiToken> {
	const cell = columnsFor<ApiToken>()
	return [
		cell.accessor(token => token.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2 font-medium'>
					<IconKey className='size-4 text-muted' />
					{row.original.name}
					{row.original.client_id ? (
						<Badge title='Granted to an MCP client through OAuth'>OAuth</Badge>
					) : null}
				</span>
			),
		}),
		cell.accessor(token => (token.admin ? 'full' : String(token.projects.length)), {
			id: 'access',
			header: 'Access',
			cell: ({ row }) => <TokenAccess token={row.original} projectName={projectName} />,
		}),
		cell.accessor(token => token.prefix, {
			id: 'prefix',
			header: 'Prefix',
			meta: { mono: true },
			cell: ({ row }) => `${row.original.prefix}…`,
		}),
		cell.accessor(token => token.last_used_at ?? '', {
			id: 'last-used',
			header: 'Last used',
			cell: ({ row }) =>
				row.original.last_used_at ? (
					<RelativeTime at={row.original.last_used_at} />
				) : (
					<span className='text-muted'>never</span>
				),
		}),
		cell.accessor(token => token.created_at, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => <RelativeTime at={row.original.created_at} />,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Confirm
					title={`Revoke ${row.original.name}?`}
					description='Anything still using this token is locked out immediately.'
					action='Revoke'
					onConfirm={() => revoke(row.original.id)}
				>
					<IconButton icon={IconTrash} label='Revoke' />
				</Confirm>
			),
		}),
	]
}

function ApiTokens() {
	const queryClient = useQueryClient()
	const tokens = useQuery(tokensQuery)
	const projects = useQuery(projectsQuery)
	const [creating, setCreating] = useState(false)
	const [name, setName] = useState('')
	const [access, setAccess] = useState(fullAccess)
	const [issued, setIssued] = useState('')

	const create = useMutation({
		mutationFn: () => {
			if (access.full) return api.createToken(name)
			if (picksNothing(access)) throw new Error('Pick at least one project, or Full access.')
			return api.createToken(name, grantList(access))
		},
		onSuccess: async result => {
			setIssued(result.value)
			setName('')
			setAccess(fullAccess)
			setCreating(false)
			await queryClient.invalidateQueries({ queryKey: ['tokens'] })
		},
	})

	const remove = useMutation({
		mutationFn: api.deleteToken,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
	})

	const { mutate: revokeToken } = remove
	const projectNames = useMemo(
		() => new Map((projects.data ?? []).map(project => [project.id, project.name])),
		[projects.data],
	)
	const columns = useMemo(
		() => tokenTableColumns(revokeToken, id => projectNames.get(id) ?? id),
		[revokeToken, projectNames],
	)

	return (
		<div className='max-w-3xl'>
			<Section
				title='API tokens'
				actions={
					<>
						<Refresh onClick={() => tokens.refetch()} busy={tokens.isFetching} />
						<Button variant='primary' onClick={() => setCreating(true)}>
							<IconPlus />
							Create token
						</Button>
					</>
				}
			>
				<ErrorText error={remove.error} />
				<DataTable
					data={tokens.data ?? []}
					columns={columns}
					loading={tokens.isLoading}
					error={tokens.error}
					getRowId={token => token.id}
					empty='No tokens issued'
				/>
			</Section>

			{issued ? (
				<Alert tone='warning' title='Copy it now. It is not shown again.' className='mb-4'>
					<span className='font-mono text-xs break-all'>{issued}</span>
					<span className='mt-2 block text-xs text-muted'>
						Connect Claude Code to the MCP server on this panel:
					</span>
					<span className='font-mono text-xs break-all'>
						{`claude mcp add --transport http vexdock ${window.location.origin}/mcp --header "Authorization: Bearer ${issued}"`}
					</span>
				</Alert>
			) : null}

			<FormDialog
				open={creating}
				onOpenChange={setCreating}
				title='Create a token'
				description='Sent as a bearer token to the API and to the MCP server on /mcp. Name it after what will hold it.'
				action='Create token'
				icon={IconPlus}
				mutation={create}
				onSubmit={() => create.mutate()}
			>
				<Field label='Token name'>
					<Input required value={name} onChange={event => setName(event.target.value)} placeholder='ci' />
				</Field>
				<Field
					label='Access'
					hint='Read: state, logs, deployments, domains. Write: also deploy, exec, variables and the database.'
				>
					<AccessPicker projects={projects.data ?? []} value={access} onChange={setAccess} />
				</Field>
			</FormDialog>
		</div>
	)
}
