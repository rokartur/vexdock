import { type ReactNode, useMemo, useState } from 'react'
import { IconKey, IconPlus, IconTrash } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { CodeBlock } from '@/components/ui/code-block'
import { CopyButton } from '@/components/ui/copy-button'
import { Skeleton } from '@/components/ui/skeleton'
import { AccessPicker } from '../components/access-picker'
import {
	Button,
	Confirm,
	EmptyState,
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

function ScopeChip({ children, title }: { children: ReactNode; title?: string }) {
	return (
		<span
			title={title}
			className='inline-flex h-5.5 items-center rounded-full border px-2 font-mono text-xs whitespace-nowrap text-secondary'
		>
			{children}
		</span>
	)
}

function TokenScopes({ token, projectName }: { token: ApiToken; projectName: (id: string) => string }) {
	if (token.admin) return <ScopeChip>full access</ScopeChip>
	if (token.projects.length > 2) {
		const names = token.projects.map(grant => `${projectName(grant.project_id)}: ${grant.level}`).join(', ')
		return <ScopeChip title={names}>{token.projects.length} projects</ScopeChip>
	}
	return token.projects.map(grant => (
		<ScopeChip key={grant.project_id}>
			{projectName(grant.project_id)}:{grant.level}
		</ScopeChip>
	))
}

function TokenRow({
	token,
	projectName,
	revoke,
}: {
	token: ApiToken
	projectName: (id: string) => string
	revoke: (id: string) => void
}) {
	return (
		<li className='grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-5 px-4 py-3 not-first:border-t not-first:border-border-subtle md:grid-cols-[minmax(0,1.25fr)_minmax(0,1.15fr)_minmax(128px,.6fr)_auto]'>
			<span className='grid min-w-0 justify-items-start gap-0.5'>
				<span className='flex max-w-full min-w-0 items-center gap-2'>
					<span className='truncate text-sm font-medium'>{token.name}</span>
					{token.client_id ? (
						<Badge size='sm' title='Granted to an MCP client through OAuth'>
							OAuth
						</Badge>
					) : null}
				</span>
				<span className='font-mono text-xs text-muted'>{token.prefix}••••</span>
			</span>
			<span className='hidden min-w-0 flex-wrap gap-1 md:flex'>
				<TokenScopes token={token} projectName={projectName} />
			</span>
			<span className='grid min-w-0 justify-items-end gap-0.5 text-right text-xs text-muted md:justify-items-start md:text-left'>
				<span className='whitespace-nowrap text-secondary'>
					{token.last_used_at ? (
						<>
							Used <RelativeTime at={token.last_used_at} />
						</>
					) : (
						'Never used'
					)}
				</span>
				<span className='hidden md:inline'>
					Created <RelativeTime at={token.created_at} />
				</span>
			</span>
			<Confirm
				title={`Revoke ${token.name}?`}
				description='Anything still using this token is locked out immediately.'
				action='Revoke'
				onConfirm={() => revoke(token.id)}
			>
				<IconButton icon={IconTrash} label='Revoke' />
			</Confirm>
		</li>
	)
}

function ApiTokens() {
	const queryClient = useQueryClient()
	const tokens = useQuery(tokensQuery)
	const projects = useQuery(projectsQuery)
	const [creating, setCreating] = useState(false)
	const [name, setName] = useState('')
	const [access, setAccess] = useState(fullAccess)
	const [issued, setIssued] = useState('')
	const [copyFailed, setCopyFailed] = useState(false)

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
	const projectName = (id: string) => projectNames.get(id) ?? id

	return (
		<div className='max-w-3xl'>
			<Section
				title='API tokens'
				actions={
					<>
						<Refresh onClick={() => tokens.refetch()} busy={tokens.isFetching} />
						<Button variant='primary' onClick={() => setCreating(true)}>
							<IconPlus size={16} stroke={1.75} />
							Create token
						</Button>
					</>
				}
			>
				<ErrorText error={remove.error ?? tokens.error} />
				{(tokens.data ?? []).length === 0 ? (
					<div className='rounded-surface border bg-surface'>
						{tokens.isLoading ? (
							<Skeleton label='Loading tokens' className='p-5' />
						) : (
							<EmptyState icon={IconKey} title='No tokens issued' />
						)}
					</div>
				) : (
					<ul className='rounded-surface border bg-surface'>
						{tokens.data?.map(token => (
							<TokenRow key={token.id} token={token} projectName={projectName} revoke={revokeToken} />
						))}
					</ul>
				)}
			</Section>

			{issued ? (
				<Alert tone='warning' title='Copy it now. It is not shown again.' className='mb-4'>
					<span className='mt-1 flex items-center gap-2'>
						<span className='min-w-0 font-mono text-xs break-all'>{issued}</span>
						<CopyButton
							value={issued}
							label='Copy token'
							iconOnly
							variant='plain'
							onError={() => setCopyFailed(true)}
						/>
					</span>
					{copyFailed ? (
						<span className='mt-1 block text-xs text-danger'>
							Copying needs HTTPS. Select the token and copy it by hand.
						</span>
					) : null}
					<span className='mt-3 mb-1.5 block text-xs text-muted'>
						Connect Claude Code to the MCP server on this panel:
					</span>
					<CodeBlock
						filename='Claude Code'
						language='bash'
						code={`claude mcp add --transport http vexdock ${window.location.origin}/mcp --header "Authorization: Bearer ${issued}"`}
					/>
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
