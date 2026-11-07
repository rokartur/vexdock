import { useId, useState } from 'react'
import { IconUserPlus } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AuthScreen } from '../components/auth-screen'
import { Button, ErrorText, Field, Input } from '../components/primitives'
import { signUp } from '../lib/auth-client'

export const Route = createFileRoute('/setup')({
	component: SetupPage,
	head: () => ({ meta: [{ title: 'Set up · Vexdock' }] }),
})

function SetupPage() {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [confirm, setConfirm] = useState('')
	const [token, setToken] = useState('')

	const mismatch = confirm.length > 0 && confirm !== password
	// Checked once the reader leaves the field or submits, not while the second copy is still being typed.
	const [checked, setChecked] = useState(false)
	const mismatchId = useId()

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
		<AuthScreen
			label='Create administrator'
			title='Create the administrator'
			lead='The only account this server will have. This step closes once it succeeds.'
		>
			<form
				className='grid'
				onSubmit={event => {
					event.preventDefault()
					setChecked(true)
					if (!mismatch) setup.mutate()
				}}
			>
				<Field label='Setup token' hint='Printed by the installer. Also in /opt/vexdock/.env.'>
					<Input
						mono
						type='password'
						autoComplete='one-time-code'
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
						onBlur={() => setChecked(confirm.length > 0)}
						aria-invalid={checked && mismatch}
						aria-describedby={checked && mismatch ? mismatchId : undefined}
						onChange={event => setConfirm(event.target.value)}
					/>
				</Field>
				{checked && mismatch ? (
					<div id={mismatchId}>
						<ErrorText error='Type the same password in both fields.' />
					</div>
				) : null}
				<ErrorText error={setup.error} />
				<Button type='submit' variant='primary' loading={setup.isPending}>
					<IconUserPlus size={16} stroke={1.75} />
					Create administrator
				</Button>
			</form>
		</AuthScreen>
	)
}
