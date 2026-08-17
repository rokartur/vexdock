import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { signIn } from '../lib/auth-client'
import { Button, ErrorText, Field } from '../components/primitives'

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
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-6 text-[16px] font-medium">Sign in</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          login.mutate()
        }}
      >
        <Field label="Email">
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <ErrorText error={login.error} />
        <Button type="submit" variant="primary" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  )
}
