import { useEffect, useState } from 'react'
import { IconCloud, IconTrash, IconWorld } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import { Button, Confirm, ErrorText, Field, FormSection, Input, RelativeTime, Switch } from '../components/primitives'
import { IslandBar, useIslandBar } from '../components/ui/save-bar'
import { api, type Certificate } from '../lib/api'
import { certificatesQuery, preload } from '../lib/queries'

const settingsQuery = queryOptions({ queryKey: ['settings'], queryFn: api.settings })

export const Route = createFileRoute('/system/settings/')({
	loader: ({ context: { queryClient } }) =>
		Promise.all([preload(queryClient, settingsQuery), preload(queryClient, certificatesQuery)]),
	component: GeneralSettings,
})

// The API writes settings as one object, so the page has one draft and one save bar, not a Save per card.
// acme_email has no field yet and is replayed as it was read.
function GeneralSettings() {
	const queryClient = useQueryClient()
	const settings = useQuery(settingsQuery)
	const certificates = useQuery(certificatesQuery)
	const [draft, setDraft] = useState({ domain: '', https: true, token: '' })

	useEffect(() => {
		const loaded = settings.data
		if (!loaded) return
		setDraft({
			domain: loaded.dashboard_domain,
			https: loaded.dashboard_https,
			token: '',
		})
	}, [settings.data])

	// The Cloudflare token is write-only: undefined keeps the stored one (the key
	// is dropped on serialization), '' clears it.
	const write = (fields: { token: string | undefined; domain: string; https: boolean }) =>
		settings.data
			? api.saveSettings({
					acme_email: settings.data.acme_email,
					dashboard_domain: fields.domain,
					dashboard_https: fields.https,
					cloudflare_api_token: fields.token,
				})
			: Promise.reject(new Error('settings not loaded yet'))
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['settings'] })

	const save = useMutation({
		mutationFn: () => write({ token: draft.token || undefined, domain: draft.domain, https: draft.https }),
		onSuccess: async () => {
			setDraft(current => ({ ...current, token: '' }))
			await refresh()
		},
	})

	// Removing the token replays the saved domain, never an unsaved edit in the draft.
	const removeToken = useMutation({
		mutationFn: () => {
			const loaded = settings.data
			return write({ token: '', domain: loaded?.dashboard_domain ?? '', https: loaded?.dashboard_https ?? true })
		},
		onSuccess: refresh,
	})

	const loaded = settings.data
	const dirty =
		loaded !== undefined &&
		(draft.domain !== loaded.dashboard_domain || draft.https !== loaded.dashboard_https || draft.token !== '')
	const bar = useIslandBar({
		dirty,
		value: draft,
		onSave: () => save.mutateAsync(),
		onDiscard: () =>
			loaded && setDraft({ domain: loaded.dashboard_domain, https: loaded.dashboard_https, token: '' }),
	})
	useBlocker({ shouldBlockFn: () => bar.guard({ kind: 'shake', focus: true }), enableBeforeUnload: false })

	const tokenStored = loaded?.cloudflare_token_set ?? false
	const certificate = certificates.data?.find(cert => cert.hostname === loaded?.dashboard_domain)
	const wildcards = certificates.data?.filter(cert => cert.hostname.startsWith('*.')).length ?? 0

	return (
		<form
			className='max-w-3xl pb-20'
			noValidate
			onSubmit={event => {
				event.preventDefault()
				void bar.save()
			}}
		>
			<ErrorText error={removeToken.error} />
			<FormSection
				title='Dashboard domain'
				icon={IconWorld}
				hint='Leave empty to keep using the server IP on port 3000.'
				aside={[
					{
						label: 'Reached at',
						value: <span className='font-mono text-xs'>{window.location.host}</span>,
					},
					{ label: 'Certificate', value: <CertificateFact certificate={certificate} /> },
				]}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Hostname'>
						<Input
							value={draft.domain}
							placeholder='panel.example.com'
							onChange={event => setDraft({ ...draft, domain: event.target.value })}
						/>
					</Field>
					<div className='flex items-center pb-3'>
						<Switch
							label='Request a certificate'
							checked={draft.https}
							onChange={https => setDraft({ ...draft, https })}
						/>
					</div>
				</div>
			</FormSection>

			<FormSection
				title='DNS challenge'
				icon={IconCloud}
				hint='Scoped to Zone:Read and DNS:Edit. Without it only HTTP-01 is used and *.example.com cannot be issued.'
				aside={[
					{ label: 'Token', value: tokenStored ? 'stored' : 'not set' },
					{ label: 'Wildcard certificates', value: wildcards },
				]}
				actions={
					tokenStored ? (
						<Confirm
							title='Remove the Cloudflare token?'
							description='Wildcard certificates stop renewing until a new token is stored.'
							action='Remove token'
							onConfirm={() => removeToken.mutate()}
						>
							<Button variant='ghost' disabled={removeToken.isPending}>
								<IconTrash size={16} stroke={1.75} />
								Remove token
							</Button>
						</Confirm>
					) : null
				}
			>
				<Field
					label='Cloudflare API token'
					hint={tokenStored ? 'Entering one replaces the stored token.' : undefined}
				>
					<Input
						type='password'
						value={draft.token}
						placeholder={tokenStored ? '••••••••' : ''}
						onChange={event => setDraft({ ...draft, token: event.target.value })}
					/>
				</Field>
			</FormSection>
			{/* Enter in a field submits only when the form has a submit button; the bar's Save lives in a portal. */}
			<button type='submit' hidden>
				Save
			</button>
			<IslandBar {...bar.props} />
		</form>
	)
}

function CertificateFact({ certificate }: { certificate: Certificate | undefined }) {
	if (!certificate) return <span className='text-muted'>none issued</span>
	if (certificate.status !== 'issued') return <span>{certificate.status}</span>
	return (
		<span>
			expires <RelativeTime at={certificate.expires_at} />
		</span>
	)
}
