import { useState } from 'react'
import { IconUserPlus } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button, ErrorText, Field, Input } from '../components/primitives'
import { signUp } from '../lib/auth-client'

export const Route = createFileRoute('/setup')({ component: SetupPage })

function SetupPage() {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [confirm, setConfirm] = useState('')
	const [token, setToken] = useState('')

	const mismatch = confirm.length > 0 && confirm !== password

	const setup = useMutation({
		mutationFn: async () => {
			// The auth service refuses a second sign-up, so this form closes itself.
			// Until the first one succeeds the setup token is what stops a stranger
			// who found the panel from claiming it.
			const { error } = await signUp.email(
				{ email, password, name: email.split('@')[0] ?? 'admin' },
				{ headers: { 'x-setup-token': token } },
			)
			if (error) throw new Error(error.message ?? 'Could not create the account')
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries()
			await navigate({ to: '/', replace: true })
		},
	})

	return (
		<div className='mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6'>
			<div className='mb-1 flex items-center gap-2.5'>
				<span className='flex size-7 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground'>
					VX
				</span>
				<h1 className='text-title font-medium'>Create administrator</h1>
			</div>
			<p className='mb-6 text-label text-muted-foreground'>
				This is the only account creation step. It closes afterwards.
			</p>
			<form
				onSubmit={event => {
					event.preventDefault()
					if (!mismatch) setup.mutate()
				}}
			>
				<Field label='Setup token' hint='Printed by the installer. Also in /opt/vexdock/.env.'>
					<Input
						type='password'
						autoComplete='off'
						required
						value={token}
						onChange={event => setToken(event.target.value)}
					/>
				</Field>
				<Field label='Email'>
					<Input
						type='email'
						autoComplete='username'
						required
						value={email}
						onChange={event => setEmail(event.target.value)}
					/>
				</Field>
				<Field label='Password' hint='At least 10 characters.'>
					<Input
						type='password'
						autoComplete='new-password'
						required
						minLength={10}
						value={password}
						onChange={event => setPassword(event.target.value)}
					/>
				</Field>
				<Field label='Confirm password'>
					<Input
						type='password'
						autoComplete='new-password'
						required
						value={confirm}
						onChange={event => setConfirm(event.target.value)}
					/>
				</Field>
				{mismatch ? <ErrorText error='Passwords do not match.' /> : null}
				<ErrorText error={setup.error} />
				<Button type='submit' variant='primary' disabled={setup.isPending || mismatch}>
					<IconUserPlus />
					{setup.isPending ? 'Creating…' : 'Create account'}
				</Button>
			</form>
		</div>
	)
}
