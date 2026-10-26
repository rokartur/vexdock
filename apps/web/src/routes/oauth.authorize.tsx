import { type ReactNode, useMemo, useState } from 'react'
import { IconCheck, IconX } from '@tabler/icons-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { Alert } from '@/components/ui/alert'
import { AccessPicker } from '../components/access-picker'
import { Logo } from '../components/logo'
import { Button, ErrorText } from '../components/primitives'
import { accessSummary, grantList, noAccess, picksNothing } from '../lib/access'
import { api, type OAuthAuthorization } from '../lib/api'
import { projectsQuery } from '../lib/queries'

export const Route = createFileRoute('/oauth/authorize')({
	component: Consent,
	head: () => ({ meta: [{ title: 'Authorize · Vexdock' }] }),
})

/**
 * The consent screen an MCP client sends the administrator to. The raw query string is passed on as the client wrote
 * it: the router's own search parsing would turn a numeric `state` into a number.
 */
function Consent() {
	const searchStr = useRouterState({ select: state => state.location.searchStr })
	const check = useQuery({ queryKey: ['oauth', searchStr], queryFn: () => api.oauthCheck(searchStr), retry: false })
	const projects = useQuery(projectsQuery)
	const [access, setAccess] = useState(noAccess)

	const authorization = useMemo(() => {
		const query = new URLSearchParams(searchStr)
		const field = (key: keyof OAuthAuthorization) => query.get(key) ?? ''
		return {
			client_id: field('client_id'),
			redirect_uri: field('redirect_uri'),
			response_type: field('response_type'),
			code_challenge: field('code_challenge'),
			code_challenge_method: field('code_challenge_method'),
			state: field('state'),
			resource: field('resource'),
		}
	}, [searchStr])

	const approve = useMutation({
		mutationFn: () => api.oauthApprove(authorization, access.full ? undefined : grantList(access)),
		onSuccess: ({ redirect }) => window.location.assign(redirect),
	})

	if (check.isPending) return null
	if (check.isError) {
		return (
			<Frame>
				<Alert tone='danger' title='This request cannot be approved'>
					{check.error.message}
				</Alert>
			</Frame>
		)
	}

	const client = check.data.client_name
	const returnTo = new URL(check.data.redirect_uri)
	const projectName = (id: string) => projects.data?.find(project => project.id === id)?.name ?? id
	const summary = accessSummary(client, access, projectName)

	const deny = () => {
		returnTo.searchParams.set('error', 'access_denied')
		if (authorization.state) returnTo.searchParams.set('state', authorization.state)
		window.location.assign(returnTo)
	}

	return (
		<Frame>
			<h1 className='text-base font-medium'>Allow {client}?</h1>
			<p className='mt-1 mb-4 text-sm text-secondary'>
				Sends you back to{' '}
				<span className='font-mono text-xs text-foreground'>{`${returnTo.protocol}//${returnTo.host}`}</span>
			</p>
			<AccessPicker projects={projects.data ?? []} value={access} onChange={setAccess} />
			{summary ? (
				<Alert tone={access.full ? 'warning' : 'info'} title={summary} className='mt-3' />
			) : (
				<p className='mt-3 text-xs text-muted'>
					Pick what {client} may reach. You can revoke it under API tokens.
				</p>
			)}
			<ErrorText error={approve.error} />
			<div className='mt-4 grid grid-cols-2 gap-2'>
				<Button onClick={deny}>
					<IconX />
					Deny
				</Button>
				<Button
					variant='primary'
					disabled={picksNothing(access) || approve.isPending}
					onClick={() => approve.mutate()}
				>
					<IconCheck />
					Allow {client}
				</Button>
			</div>
		</Frame>
	)
}

function Frame({ children }: { children: ReactNode }) {
	return (
		<div className='mx-auto flex min-h-dvh max-w-md enter-children flex-col justify-center px-6'>
			<div className='mb-6 flex items-center gap-2.5'>
				<Logo className='size-7' />
				<span className='text-base font-medium'>vexdock</span>
			</div>
			{children}
		</div>
	)
}
