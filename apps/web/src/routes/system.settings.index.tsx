import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Check, ErrorText, Field, Section } from '../components/primitives'
import { api } from '../lib/api'
import { BRAND_COLORS, DEFAULT_BRAND } from '../lib/brand'
import { cn } from '../utils/cn'

export const Route = createFileRoute('/system/settings/')({ component: GeneralSettings })

/**
 * The whole tab is one form because the API writes settings as a single object:
 * saving per section would only force each one to replay the fields it does not
 * own. acme_email has no field yet and is replayed as it was read.
 */
function GeneralSettings() {
	const queryClient = useQueryClient()
	const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
	const [draft, setDraft] = useState({ domain: '', https: true, webhook: '', token: '', brand: '' })

	useEffect(() => {
		const loaded = settings.data
		if (!loaded) return
		setDraft({
			domain: loaded.dashboard_domain,
			https: loaded.dashboard_https,
			webhook: loaded.notify_webhook_url,
			token: '',
			brand: loaded.brand_color,
		})
	}, [settings.data])

	// The Cloudflare token is write-only: undefined keeps the stored one (the key
	// is dropped on serialisation), '' clears it.
	const save = useMutation({
		mutationFn: (cloudflareToken: string | undefined) =>
			settings.data
				? api.saveSettings({
						acme_email: settings.data.acme_email,
						dashboard_domain: draft.domain,
						dashboard_https: draft.https,
						notify_webhook_url: draft.webhook,
						brand_color: draft.brand,
						cloudflare_api_token: cloudflareToken,
					})
				: Promise.reject(new Error('settings not loaded yet')),
		onSuccess: async () => {
			setDraft(current => ({ ...current, token: '' }))
			await queryClient.invalidateQueries({ queryKey: ['settings'] })
		},
	})

	const apply = () => save.mutate(draft.token || undefined)
	const tokenStored = settings.data?.cloudflare_token_set ?? false

	return (
		<div className='max-w-2xl'>
			<Section
				title='Dashboard domain'
				description='serve the panel on your own hostname with HTTPS'
				onSave={apply}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Hostname' hint='Leave empty to keep using the server IP on port 3000.'>
						<input
							value={draft.domain}
							placeholder='panel.example.com'
							onChange={event => setDraft({ ...draft, domain: event.target.value })}
						/>
					</Field>
					<div className='flex items-center pb-3'>
						<Check
							label='Request a certificate'
							checked={draft.https}
							onChange={https => setDraft({ ...draft, https })}
						/>
					</div>
				</div>
			</Section>

			<Section title='Brand colour' description='the accent used across the panel' onSave={apply}>
				<Field label='Accent' hint='Buttons, links, charts and the active sidebar row.'>
					<div className='flex flex-wrap items-center gap-2'>
						{BRAND_COLORS.map(color => {
							// An empty setting means the shipped orange, so it selects that swatch.
							const selected = (draft.brand || DEFAULT_BRAND).toLowerCase() === color
							return (
								<button
									key={color}
									type='button'
									aria-label={color}
									aria-pressed={selected}
									onClick={() => setDraft({ ...draft, brand: color === DEFAULT_BRAND ? '' : color })}
									style={{ background: color }}
									className={cn(
										'size-6 cursor-pointer rounded-full transition-[scale] active:scale-[0.95] motion-reduce:active:scale-100',
										selected && 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
									)}
								/>
							)
						})}
					</div>
				</Field>
			</Section>

			<Section
				title='Deploy notifications'
				description='posted when a deployment succeeds or fails'
				onSave={apply}
			>
				<Field
					label='Webhook URL'
					hint='Discord and Slack webhook URLs are detected automatically. Anything else receives the raw event as JSON. Leave empty to disable.'
				>
					<input
						type='url'
						value={draft.webhook}
						placeholder='https://discord.com/api/webhooks/…'
						onChange={event => setDraft({ ...draft, webhook: event.target.value })}
					/>
				</Field>
			</Section>

			<Section title='DNS challenge' description='required for wildcard certificates' onSave={apply}>
				<Field
					label='Cloudflare API token'
					hint={
						tokenStored
							? 'A token is stored. Enter a new one to replace it.'
							: 'Scoped to Zone:Read and DNS:Edit. Without it only HTTP-01 is used and *.example.com cannot be issued.'
					}
				>
					<input
						type='password'
						value={draft.token}
						placeholder={tokenStored ? '••••••••' : ''}
						onChange={event => setDraft({ ...draft, token: event.target.value })}
					/>
				</Field>
			</Section>

			<ErrorText error={save.error} />
			<div className='flex items-center gap-2'>
				<Button variant='primary' onClick={apply} disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save'}
				</Button>
				{tokenStored ? (
					<Button variant='ghost' onClick={() => save.mutate('')} disabled={save.isPending}>
						Remove token
					</Button>
				) : null}
			</div>
		</div>
	)
}
