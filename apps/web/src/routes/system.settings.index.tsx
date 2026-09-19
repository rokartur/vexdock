import { useEffect, useState } from 'react'
import { IconCloud, IconTrash, IconWorld } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
	Button,
	ErrorText,
	Field,
	FormSection,
	Input,
	RelativeTime,
	SaveButton,
	Switch,
} from '../components/primitives'
import { api, type Certificate } from '../lib/api'

export const Route = createFileRoute('/system/settings/')({ component: GeneralSettings })

/**
 * The API writes settings as one object, so every Save is the same call and replays the fields its card does not own.
 * acme_email has no field yet and is replayed as it was read.
 */
function GeneralSettings() {
	const queryClient = useQueryClient()
	const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
	const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })
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
	const save = useMutation({
		mutationFn: (fields: { token: string | undefined; domain: string; https: boolean }) =>
			settings.data
				? api.saveSettings({
						acme_email: settings.data.acme_email,
						dashboard_domain: fields.domain,
						dashboard_https: fields.https,
						cloudflare_api_token: fields.token,
					})
				: Promise.reject(new Error('settings not loaded yet')),
		onSuccess: async () => {
			setDraft(current => ({ ...current, token: '' }))
			await queryClient.invalidateQueries({ queryKey: ['settings'] })
		},
	})

	const apply = () => save.mutate({ token: draft.token || undefined, domain: draft.domain, https: draft.https })

	// Removing the token replays the saved domain, never an unsaved edit sitting
	// in the card above it.
	const removeToken = () => {
		const loaded = settings.data
		if (!loaded) return
		save.mutate({ token: '', domain: loaded.dashboard_domain, https: loaded.dashboard_https })
	}
	const tokenStored = settings.data?.cloudflare_token_set ?? false
	const saveButton = <SaveButton mutation={save} />
	const certificate = certificates.data?.find(cert => cert.hostname === settings.data?.dashboard_domain)
	const wildcards = certificates.data?.filter(cert => cert.hostname.startsWith('*.')).length ?? 0

	return (
		<div className='max-w-3xl'>
			<ErrorText error={save.error} />
			<FormSection
				title='Dashboard domain'
				description='Serve the panel on your own hostname with HTTPS.'
				icon={IconWorld}
				hint='Leave empty to keep using the server IP on port 3000.'
				actions={saveButton}
				aside={[
					{
						label: 'Reached at',
						value: <span className='font-mono text-label'>{window.location.host}</span>,
					},
					{ label: 'Certificate', value: <CertificateFact certificate={certificate} /> },
				]}
				onSave={apply}
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
				description='Required for wildcard certificates.'
				icon={IconCloud}
				hint='Scoped to Zone:Read and DNS:Edit. Without it only HTTP-01 is used and *.example.com cannot be issued.'
				aside={[
					{ label: 'Token', value: tokenStored ? 'stored' : 'not set' },
					{ label: 'Wildcard certificates', value: wildcards },
				]}
				actions={
					<>
						{tokenStored ? (
							<Button variant='ghost' onClick={removeToken} disabled={save.isPending}>
								<IconTrash />
								Remove token
							</Button>
						) : null}
						{saveButton}
					</>
				}
				onSave={apply}
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
		</div>
	)
}

function CertificateFact({ certificate }: { certificate: Certificate | undefined }) {
	if (!certificate) return <span className='text-muted-foreground'>none issued</span>
	if (certificate.status !== 'issued') return <span>{certificate.status}</span>
	return (
		<span>
			expires <RelativeTime at={certificate.expires_at} />
		</span>
	)
}
