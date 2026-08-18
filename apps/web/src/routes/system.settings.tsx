import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, Check, ErrorText, Field, Page, Refresh, Section } from '../components/primitives'
import { api, type ApiToken, type Registry, type Settings, type SettingsUpdate } from '../lib/api'
import { since } from '../lib/format'

function registryTableColumns(remove: (id: string) => void): Columns<Registry> {
	const cell = columnsFor<Registry>()
	return [
		cell.accessor(registry => registry.name, { id: 'name', header: 'Name' }),
		cell.accessor(registry => registry.url, { id: 'url', header: 'URL', meta: { mono: true } }),
		cell.accessor(registry => registry.username, { id: 'username', header: 'Username', meta: { mono: true } }),
		cell.accessor(registry => registry.created_at, {
			id: 'added',
			header: 'Added',
			cell: ({ row }) => since(row.original.created_at),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Button variant='ghost' onClick={() => remove(row.original.id)}>
					remove
				</Button>
			),
		}),
	]
}

function tokenTableColumns(revoke: (id: string) => void): Columns<ApiToken> {
	const cell = columnsFor<ApiToken>()
	return [
		cell.accessor(token => token.name, { id: 'name', header: 'Name' }),
		cell.accessor(token => token.prefix, {
			id: 'prefix',
			header: 'Prefix',
			meta: { mono: true },
			cell: ({ row }) => `${row.original.prefix}…`,
		}),
		cell.accessor(token => token.last_used_at ?? '', {
			id: 'last-used',
			header: 'Last used',
			cell: ({ row }) => (row.original.last_used_at ? since(row.original.last_used_at) : 'never'),
		}),
		cell.accessor(token => token.created_at, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => since(row.original.created_at),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Button variant='ghost' onClick={() => revoke(row.original.id)}>
					revoke
				</Button>
			),
		}),
	]
}

export const Route = createFileRoute('/system/settings')({ component: SettingsPage })

function SettingsPage() {
	return (
		<Page title='Settings'>
			<DashboardDomain />
			<Notifications />
			<DnsProvider />
			<Registries />
			<ApiTokens />
		</Page>
	)
}

// Settings are written as one object, so each section replays the values it
// does not own. cloudflare_token_set is read-only and never sent back.
function toUpdate(settings: Settings): SettingsUpdate {
	return {
		dashboard_domain: settings.dashboard_domain,
		dashboard_https: settings.dashboard_https,
		acme_email: settings.acme_email,
		notify_webhook_url: settings.notify_webhook_url,
	}
}

const notLoaded = () => Promise.reject(new Error('settings not loaded yet'))

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
			settings.data
				? api.saveSettings({
						...toUpdate(settings.data),
						dashboard_domain: domain,
						dashboard_https: https,
					})
				: notLoaded(),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
	})

	return (
		<Section title='Dashboard domain' description='serve the panel on your own hostname with HTTPS'>
			<div className='grid gap-x-6 border-t border-border pt-3 md:grid-cols-2'>
				<Field label='Hostname' hint='Leave empty to keep using the server IP on port 3000.'>
					<input
						value={domain}
						placeholder='panel.example.com'
						onChange={event => setDomain(event.target.value)}
					/>
				</Field>
				<div className='flex items-center pb-3'>
					<Check label='Request a certificate' checked={https} onChange={setHttps} />
				</div>
			</div>
			<ErrorText error={save.error} />
			<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
				{save.isPending ? 'Applying…' : 'Save'}
			</Button>
		</Section>
	)
}

/** One outgoing webhook for finished deployments. */
function Notifications() {
	const queryClient = useQueryClient()
	const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
	const [url, setUrl] = useState('')

	useEffect(() => {
		if (settings.data) setUrl(settings.data.notify_webhook_url)
	}, [settings.data])

	const save = useMutation({
		mutationFn: () =>
			settings.data ? api.saveSettings({ ...toUpdate(settings.data), notify_webhook_url: url }) : notLoaded(),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
	})

	return (
		<Section title='Deploy notifications' description='posted when a deployment succeeds or fails'>
			<div className='border-t border-border pt-3'>
				<Field
					label='Webhook URL'
					hint='Discord and Slack webhook URLs are detected automatically. Anything else receives the raw event as JSON. Leave empty to disable.'
				>
					<input
						type='url'
						value={url}
						placeholder='https://discord.com/api/webhooks/…'
						onChange={event => setUrl(event.target.value)}
					/>
				</Field>
			</div>
			<ErrorText error={save.error} />
			<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
				{save.isPending ? 'Saving…' : 'Save'}
			</Button>
		</Section>
	)
}

/** A Cloudflare token switches certificate issuance to DNS-01, which unlocks wildcards. */
function DnsProvider() {
	const queryClient = useQueryClient()
	const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
	const [token, setToken] = useState('')

	const save = useMutation({
		mutationFn: (value: string) =>
			settings.data ? api.saveSettings({ ...toUpdate(settings.data), cloudflare_api_token: value }) : notLoaded(),
		onSuccess: async () => {
			setToken('')
			await queryClient.invalidateQueries({ queryKey: ['settings'] })
		},
	})

	const configured = settings.data?.cloudflare_token_set ?? false

	return (
		<Section title='DNS challenge' description='required for wildcard certificates'>
			<div className='flex items-end gap-2 border-t border-border pt-3'>
				<div className='w-96'>
					<Field
						label='Cloudflare API token'
						hint={
							configured
								? 'A token is stored. Enter a new one to replace it.'
								: 'Scoped to Zone:Read and DNS:Edit. Without it only HTTP-01 is used and *.example.com cannot be issued.'
						}
					>
						<input
							type='password'
							value={token}
							placeholder={configured ? '••••••••' : ''}
							onChange={event => setToken(event.target.value)}
						/>
					</Field>
				</div>
				<div className='pb-3'>
					<Button variant='primary' onClick={() => save.mutate(token)} disabled={!token || save.isPending}>
						{save.isPending ? 'Saving…' : 'Save token'}
					</Button>
				</div>
				{configured ? (
					<div className='pb-3'>
						<Button variant='ghost' onClick={() => save.mutate('')} disabled={save.isPending}>
							remove
						</Button>
					</div>
				) : null}
			</div>
			<ErrorText error={save.error} />
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

	const { mutate: removeRegistry } = remove
	const columns = useMemo(() => registryTableColumns(removeRegistry), [removeRegistry])

	return (
		<Section
			title='Private registries'
			description='credentials are encrypted at rest'
			actions={<Refresh onClick={() => registries.refetch()} busy={registries.isFetching} />}
		>
			<DataTable
				data={registries.data ?? []}
				columns={columns}
				loading={registries.isLoading}
				getRowId={registry => registry.id}
				empty='No registries configured. Public images work without one.'
			/>

			<form
				className='mt-3 grid gap-x-6 md:grid-cols-4'
				onSubmit={event => {
					event.preventDefault()
					create.mutate()
				}}
			>
				<Field label='Name'>
					<input
						required
						value={form.name}
						onChange={event => setForm({ ...form, name: event.target.value })}
					/>
				</Field>
				<Field label='Registry URL'>
					<input
						required
						placeholder='ghcr.io'
						value={form.url}
						onChange={event => setForm({ ...form, url: event.target.value })}
					/>
				</Field>
				<Field label='Username'>
					<input
						required
						value={form.username}
						onChange={event => setForm({ ...form, username: event.target.value })}
					/>
				</Field>
				<Field label='Token'>
					<input
						required
						type='password'
						value={form.password}
						onChange={event => setForm({ ...form, password: event.target.value })}
					/>
				</Field>
				<div className='md:col-span-4'>
					<ErrorText error={create.error} />
					<Button type='submit' disabled={create.isPending}>
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
		onSuccess: async result => {
			setIssued(result.value)
			setName('')
			await queryClient.invalidateQueries({ queryKey: ['tokens'] })
		},
	})

	const remove = useMutation({
		mutationFn: (id: string) => api.deleteToken(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
	})

	const { mutate: revokeToken } = remove
	const columns = useMemo(() => tokenTableColumns(revokeToken), [revokeToken])

	return (
		<Section
			title='API tokens'
			description='for CI and scripted deploys'
			actions={<Refresh onClick={() => tokens.refetch()} busy={tokens.isFetching} />}
		>
			<DataTable
				data={tokens.data ?? []}
				columns={columns}
				loading={tokens.isLoading}
				getRowId={token => token.id}
				empty='No tokens issued.'
			/>

			{issued ? (
				<p className='mt-3 border border-border p-2 font-mono text-body break-all'>
					{issued}
					<span className='mt-1 block font-sans text-label text-amber-400'>
						Copy it now. It is not shown again.
					</span>
				</p>
			) : null}

			<form
				className='mt-3 flex items-end gap-2'
				onSubmit={event => {
					event.preventDefault()
					create.mutate()
				}}
			>
				<div className='w-64'>
					<Field label='Token name'>
						<input required value={name} onChange={event => setName(event.target.value)} placeholder='ci' />
					</Field>
				</div>
				<div className='pb-3'>
					<Button type='submit' disabled={create.isPending}>
						Create token
					</Button>
				</div>
			</form>
			<ErrorText error={create.error ?? remove.error} />
		</Section>
	)
}
