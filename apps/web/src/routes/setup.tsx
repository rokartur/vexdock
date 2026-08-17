import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api, setCsrfToken } from '../lib/api'
import { Button, ErrorText, Field } from '../components/ui'

export const Route = createFileRoute('/setup')({ component: SetupPage })

function SetupPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const mismatch = confirm.length > 0 && confirm !== password

  const setup = useMutation({
    mutationFn: () => api.setup(email, password),
    onSuccess: async (result) => {
      setCsrfToken(result.csrf_token)
      await queryClient.invalidateQueries()
      await navigate({ to: '/', replace: true })
    },
  })

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-[15px] font-medium">Create administrator</h1>
      <p className="mb-6 text-[12px] text-[#8a8a8a]">This is the only account creation step. It closes afterwards.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!mismatch) setup.mutate()
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
        <Field label="Password" hint="At least 10 characters.">
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="Confirm password">
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
        {mismatch ? <p className="py-2 text-[12px] text-[#ff5f56]">Passwords do not match.</p> : null}
        <ErrorText error={setup.error} />
        <Button type="submit" variant="primary" disabled={setup.isPending || mismatch}>
          {setup.isPending ? 'Creating…' : 'Create account'}
        </Button>
      </form>
    </div>
  )
}
