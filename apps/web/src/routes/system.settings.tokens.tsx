import { useMemo, useState } from 'react'
import { IconKey, IconPlus, IconTrash } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { CodeBlock } from '@/components/ui/code-block'
import { CopyButton } from '@/components/ui/copy-button'
import { AccessPicker } from '../components/access-picker'
import { IntegrationList } from '../components/integration-list'
import {
	Button,
	Confirm,
	EmptyState,
	ErrorText,
	ListPlaceholder,
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

function TokenScopes({ token, projectName }: { token: ApiToken; projectName: (id: string) => string }) {
	if (token.admin) return <Badge>Full access</Badge>
	return token.projects.map(grant => (
		<Badge key={grant.project_id} className='max-w-full wrap-anywhere whitespace-normal'>
			{projectName(grant.project_id)}:{grant.level}
		</Badge>
	))
}

function TokenRow({
	token,
	projectName,
	revoke,
	revoking,
}: {
	token: ApiToken
	projectName: (id: string) => string
	revoke: (id: string) => void
	revoking: string | undefined
}) {
	return (
		<li className='grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-5 px-4 py-3 not-first:border-t not-first:border-border-subtle md:grid-cols-[minmax(0,1.25fr)_minmax(0,1.15fr)_minmax(128px,.6fr)_auto]'>
			<span className='grid min-w-0 justify-items-start gap-0.5'>
				<span className='flex max-w-full min-w-0 items-center gap-2'>
					<span className='min-w-0 text-sm font-medium wrap-anywhere'>{token.name}</span>
					{token.client_id ? (
						<Badge size='sm' title='Granted to an MCP client through OAuth'>
							OAuth
						</Badge>
					) : null}
				</span>
				<span className='font-mono text-xs text-muted'>
					{token.prefix}
					<span aria-hidden>••••</span>
					<span className='sr-only'> (rest hidden)</span>
				</span>
				{/* Below md the scopes column is gone, so they ride under the name. */}
				<span className='mt-1 flex min-w-0 flex-wrap gap-1 md:hidden'>
					<TokenScopes token={token} projectName={projectName} />
				</span>
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
				<span className='whitespace-nowrap'>
					Created <RelativeTime at={token.created_at} />
				</span>
			</span>
			<Confirm
				title={`Revoke ${token.name}?`}
				description='Anything still using this token is locked out immediately.'
				action='Revoke token'
				onConfirm={() => revoke(token.id)}
			>
				<IconButton
					icon={IconTrash}
					label={`Revoke ${token.name}`}
					loading={revoking === token.id}
					disabled={revoking !== undefined}
				/>
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
			setCopyFailed(false)
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
	// Never the raw id: a failed or pending projects read shows its error above, not UUIDs in the badges.
	const projectName = (id: string) => projectNames.get(id) ?? '-'

	return (
		<div className='max-w-3xl'>
			<Section
				title='API tokens'
				total={tokens.data?.length}
				actions={
					<>
						<Refresh onClick={() => tokens.refetch()} />
						<Button variant='primary' size='sm' onClick={() => setCreating(true)}>
							<IconPlus size={16} stroke={1.75} />
							Create token
						</Button>
					</>
				}
			>
				<ErrorText error={remove.error} />
				<ErrorText error={tokens.error} />
				<ErrorText error={projects.error} />
				<ErrorText
					error={
						issued && copyFailed ? 'Copying needs HTTPS. Select the token below and copy it by hand.' : null
					}
				/>
				{issued ? (
					<Alert tone='warning' title='Copy it now: it is not shown again' className='mb-3'>
						<span className='mt-1 flex items-center gap-2'>
							<span className='min-w-0 font-mono text-xs wrap-anywhere'>{issued}</span>
							<CopyButton
								value={issued}
								label='Copy token'
								iconOnly
								variant='plain'
								onCopied={() => setCopyFailed(false)}
								onError={() => setCopyFailed(true)}
							/>
						</span>
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
				{tokens.data?.length ? (
					<IntegrationList>
						{tokens.data.map(token => (
							<TokenRow
								key={token.id}
								token={token}
								projectName={projectName}
								revoke={revokeToken}
								revoking={remove.isPending ? remove.variables : undefined}
							/>
						))}
					</IntegrationList>
				) : tokens.error ? null : (
					<ListPlaceholder loading={tokens.isLoading} label='Loading tokens'>
						<EmptyState
							icon={IconKey}
							title='No tokens issued'
							description='Create one for CI or an MCP client.'
						/>
					</ListPlaceholder>
				)}
			</Section>

			<FormDialog
				open={creating}
				onOpenChange={open => {
					setCreating(open)
					if (open) return
					setName('')
					setAccess(fullAccess)
				}}
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
					<AccessPicker projects={projects} value={access} onChange={setAccess} />
				</Field>
			</FormDialog>
		</div>
	)
}
