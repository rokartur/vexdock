import { useState } from 'react'
import { IconLogin2 } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button, ErrorText, Field, Input } from '../components/primitives'
import { signIn } from '../lib/auth-client'

export const Route = createFileRoute('/login')({ component: LoginPage })

function LoginPage() {
	const navigate = useNavigate()
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
			await navigate({ to: '/', replace: true })
		},
	})

	return (
		<div className='mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6'>
			<div className='mb-6 flex items-center gap-2.5'>
				<span className='flex size-7 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground'>
					VX
				</span>
				<h1 className='text-title font-medium'>Sign in to vexdock</h1>
			</div>
			<form
				onSubmit={event => {
					event.preventDefault()
					login.mutate()
				}}
			>
				<Field label='Email'>
					<Input
						type='email'
						autoComplete='username'
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
				<Button type='submit' variant='primary' disabled={login.isPending}>
					<IconLogin2 />
					{login.isPending ? 'Signing in…' : 'Sign in'}
				</Button>
			</form>
		</div>
	)
}
