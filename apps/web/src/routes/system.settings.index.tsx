import { useState } from 'react'
import { IconCloud, IconTrash, IconWorld } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormSection,
	FormSkeleton,
	Input,
	PendingReading,
	RelativeTime,
	Status,
	Switch,
} from '../components/primitives'
import { IslandBar, useIslandBar } from '../components/ui/save-bar'
import { api, type Certificate, certificateStatus, type Settings } from '../lib/api'
import { certificatesQuery, preload } from '../lib/queries'

const settingsQuery = queryOptions({ queryKey: ['settings'], queryFn: api.settings })

export const Route = createFileRoute('/system/settings/')({
	loader: ({ context: { queryClient } }) =>
		Promise.all([preload(queryClient, settingsQuery), preload(queryClient, certificatesQuery)]),
	component: GeneralSettings,
})

function GeneralSettings() {
	const settings = useQuery(settingsQuery)
	if (!settings.data) {
		return settings.error ? (
			<ErrorText error={settings.error} />
		) : (
			<FormSkeleton label='Loading settings' cards={2} />
		)
	}
	return <SettingsForm loaded={settings.data} />
}

// The API writes settings as one object, so the page has one draft and one save bar, not a Save per card.
// acme_email has no field yet and is replayed as it was read.
function SettingsForm({ loaded }: { loaded: Settings }) {
	const queryClient = useQueryClient()
	const certificates = useQuery(certificatesQuery)
	const saved = { domain: loaded.dashboard_domain, https: loaded.dashboard_https, token: '' }
	const [draft, setDraft] = useState(saved)

	// The Cloudflare token is write-only: undefined keeps the stored one (the key
	// is dropped on serialization), '' clears it.
	const write = (fields: { token: string | undefined; domain: string; https: boolean }) =>
		api.saveSettings({
			acme_email: loaded.acme_email,
			dashboard_domain: fields.domain,
			dashboard_https: fields.https,
			cloudflare_api_token: fields.token,
		})
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
		mutationFn: () => write({ token: '', domain: saved.domain, https: saved.https }),
		onSuccess: refresh,
	})

	const dirty = draft.domain !== saved.domain || draft.https !== saved.https || draft.token !== ''
	const bar = useIslandBar({
		dirty,
		value: draft,
		onSave: () => save.mutateAsync(),
		onDiscard: () => setDraft(saved),
	})
	useBlocker({ shouldBlockFn: () => bar.guard({ kind: 'shake', focus: true }), enableBeforeUnload: false })

	const tokenStored = loaded.cloudflare_token_set
	const certificate = certificates.data?.find(cert => cert.hostname === loaded.dashboard_domain)
	const wildcards = certificates.data?.filter(cert => cert.hostname.startsWith('*.')).length
	const certificatesPending = <PendingReading label='certificates' failed={certificates.isError} />

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
			<ErrorText error={certificates.error} />
			<FormSection
				title='Dashboard domain'
				icon={IconWorld}
				hint='Leave empty to keep using the server IP on the dashboard port the installer set (3000 by default).'
				aside={[
					{
						label: 'Reached at',
						value: <span className='font-mono text-xs'>{window.location.host}</span>,
					},
					{
						label: 'Certificate',
						value: certificates.data ? <CertificateFact certificate={certificate} /> : certificatesPending,
					},
				]}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Hostname'>
						<Input
							mono
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
					{ label: 'Wildcard certificates', value: wildcards ?? certificatesPending },
				]}
				actions={
					tokenStored ? (
						<Confirm
							title='Remove the Cloudflare token?'
							description='Wildcard certificates stop renewing until a new token is stored.'
							action='Remove token'
							onConfirm={() => removeToken.mutate()}
						>
							<Button variant='ghost' loading={removeToken.isPending}>
								<IconTrash size={16} stroke={1.75} />
								Remove token
							</Button>
						</Confirm>
					) : null
				}
			>
				<Field
					label='Cloudflare API token'
					hint={tokenStored ? 'One is saved; typing replaces it.' : undefined}
				>
					<Input
						mono
						type='password'
						autoComplete='new-password'
						value={draft.token}
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
	const status = certificateStatus(certificate)
	if (status === 'expired')
		return (
			<span className='inline-flex items-center gap-1.5'>
				<Status value='expired' /> <RelativeTime at={certificate.expires_at} />
			</span>
		)
	if (status !== 'issued') return <Status value={status} />
	return (
		<span>
			expires <RelativeTime at={certificate.expires_at} future />
		</span>
	)
}
