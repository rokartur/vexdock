import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { api } from '../lib/api'
import { Button, Cell, Empty, ErrorText, Field, Row, Section, Skeleton, Table } from '../components/primitives'
import { since } from '../lib/format'

export const Route = createFileRoute('/system/settings')({ component: SettingsPage })

function SettingsPage() {
  return (
    <>
      <h1 className="mb-5 text-[15px] font-medium">Settings</h1>
      <DashboardDomain />
      <Registries />
      <ApiTokens />
    </>
  )
}

/** Publishes the panel itself on a hostname through the same Nginx. */
function DashboardDomain() {
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const [domain, setDomain] = useState('')
  const [https, setHttps] = useState(true)

  useEffect(() => {
    if (!settings.data) return
    setDomain(settings.data.dashboard_domain)
    setHttps(settings.data.dashboard_https)
  }, [settings.data])

  const save = useMutation({
    mutationFn: () =>
      api.saveSettings({
        dashboard_domain: domain,
        dashboard_https: https,
        acme_email: settings.data?.acme_email ?? '',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  })

  return (
    <Section title="Dashboard domain" description="serve the panel on your own hostname with HTTPS">
      <div className="grid gap-x-6 border-t border-[#1f1f1f] pt-3 md:grid-cols-2">
        <Field label="Hostname" hint="Leave empty to keep using the server IP on port 3000.">
          <input value={domain} placeholder="panel.example.com" onChange={(event) => setDomain(event.target.value)} />
        </Field>
        <div className="flex items-center pb-3">
          <label className="flex items-center gap-1.5 text-[12px]">
            <input
              type="checkbox"
              className="!w-auto"
              checked={https}
              onChange={(event) => setHttps(event.target.checked)}
            />
            Request a certificate
          </label>
        </div>
      </div>
      <ErrorText error={save.error} />
      <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? 'Applying…' : 'Save'}
      </Button>
    </Section>
  )
}

function Registries() {
  const queryClient = useQueryClient()
  const registries = useQuery({ queryKey: ['registries'], queryFn: api.registries })
  const [form, setForm] = useState({ name: '', url: '', username: '', password: '' })

  const create = useMutation({
    mutationFn: () => api.createRegistry(form),
    onSuccess: async () => {
      setForm({ name: '', url: '', username: '', password: '' })
      await queryClient.invalidateQueries({ queryKey: ['registries'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRegistry(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['registries'] }),
  })

  return (
    <Section title="Private registries" description="credentials are encrypted at rest">
      {registries.isLoading ? (
        <Skeleton rows={2} />
      ) : registries.data?.length === 0 ? (
        <Empty>No registries configured. Public images work without one.</Empty>
      ) : (
        <Table head={['Name', 'URL', 'Username', 'Added', '']}>
          {registries.data?.map((registry) => (
            <Row key={registry.id}>
              <Cell>{registry.name}</Cell>
              <Cell mono>{registry.url}</Cell>
              <Cell mono>{registry.username}</Cell>
              <Cell>{since(registry.created_at)}</Cell>
              <Cell right>
                <Button variant="ghost" onClick={() => remove.mutate(registry.id)}>
                  remove
                </Button>
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      <form
        className="mt-3 grid gap-x-6 md:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <Field label="Name">
          <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="Registry URL">
          <input
            required
            placeholder="ghcr.io"
            value={form.url}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
          />
        </Field>
        <Field label="Username">
          <input
            required
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
          />
        </Field>
        <Field label="Token">
          <input
            required
            type="password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
        </Field>
        <div className="md:col-span-4">
          <ErrorText error={create.error} />
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Verifying…' : 'Add registry'}
          </Button>
        </div>
      </form>
    </Section>
  )
}

function ApiTokens() {
  const queryClient = useQueryClient()
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.tokens })
  const [name, setName] = useState('')
  const [issued, setIssued] = useState('')

  const create = useMutation({
    mutationFn: () => api.createToken(name),
    onSuccess: async (result) => {
      setIssued(result.value)
      setName('')
      await queryClient.invalidateQueries({ queryKey: ['tokens'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteToken(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
  })

  return (
    <Section title="API tokens" description="for CI and scripted deploys">
      {tokens.data?.length === 0 ? (
        <Empty>No tokens issued.</Empty>
      ) : (
        <Table head={['Name', 'Prefix', 'Last used', 'Created', '']}>
          {tokens.data?.map((token) => (
            <Row key={token.id}>
              <Cell>{token.name}</Cell>
              <Cell mono>{token.prefix}…</Cell>
              <Cell>{token.last_used_at ? since(token.last_used_at) : 'never'}</Cell>
              <Cell>{since(token.created_at)}</Cell>
              <Cell right>
                <Button variant="ghost" onClick={() => remove.mutate(token.id)}>
                  revoke
                </Button>
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      {issued ? (
        <p className="mt-3 border border-[#2e2e2e] p-2 font-mono text-[12px] break-all">
          {issued}
          <span className="mt-1 block font-sans text-[11px] text-[#f5c451]">
            Copy it now. It is not shown again.
          </span>
        </p>
      ) : null}

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <div className="w-64">
          <Field label="Token name">
            <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="ci" />
          </Field>
        </div>
        <div className="pb-3">
          <Button type="submit" disabled={create.isPending}>
            Create token
          </Button>
        </div>
      </form>
      <ErrorText error={create.error ?? remove.error} />
    </Section>
  )
}
