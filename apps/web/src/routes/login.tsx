import { useState } from 'react'
import { IconLogin2 } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { safeNext } from '../components/auth-gate'
import { AuthScreen } from '../components/auth-screen'
import { Button, ErrorText, Field, Input } from '../components/primitives'
import { signIn } from '../lib/auth-client'

export const Route = createFileRoute('/login')({
	validateSearch: (search: Record<string, unknown>): { next?: string } => ({ next: safeNext(search.next) }),
	component: LoginPage,
	// Pages inside the shell name the tab themselves; this one is outside it.
	head: () => ({ meta: [{ title: 'Sign in · Vexdock' }] }),
})

function LoginPage() {
	const navigate = useNavigate()
	const { next } = Route.useSearch()
	const queryClient = useQueryClient()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')

	const login = useMutation({
		mutationFn: async () => {
			const { error } = await signIn.email({ email, password })
			if (error) throw new Error(error.message ?? 'Invalid email or password')
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries()
			await navigate({ href: next ?? '/', replace: true })
		},
	})

	return (
		<AuthScreen
			label='Sign in'
			title='Sign in to vexdock'
			lead='The administrator account this server was set up with.'
		>
			<form
				className='grid'
				onSubmit={event => {
					event.preventDefault()
					login.mutate()
				}}
			>
				<Field label='Email'>
					<Input
						type='email'
						autoComplete='username'
						autoCapitalize='none'
						spellCheck={false}
						placeholder='name@example.com'
						required
						value={email}
						onChange={event => setEmail(event.target.value)}
					/>
				</Field>
				<Field label='Password'>
					<Input
						type='password'
						autoComplete='current-password'
						required
						value={password}
						onChange={event => setPassword(event.target.value)}
					/>
				</Field>
				<ErrorText error={login.error} />
				<Button type='submit' variant='primary' loading={login.isPending}>
					<IconLogin2 />
					Sign in
				</Button>
			</form>
		</AuthScreen>
	)
}
