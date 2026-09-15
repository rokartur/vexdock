import { useEffect, useState } from 'react'
import { IconCloud, IconPalette, IconTrash, IconWorld } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, ErrorText, Field, FormSection, Input, SaveButton, Switch } from '../components/primitives'
import { api } from '../lib/api'
import { BRAND_COLORS, DEFAULT_BRAND } from '../lib/brand'
import { cn } from '../utils/cn'

export const Route = createFileRoute('/system/settings/')({ component: GeneralSettings })

/**
 * The API writes settings as one object, so every Save is the same call and replays the fields its card does not own.
 * acme_email has no field yet and is replayed as it was read.
 */
function GeneralSettings() {
	const queryClient = useQueryClient()
	const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
	const [draft, setDraft] = useState({ domain: '', https: true, token: '', brand: '' })

	useEffect(() => {
		const loaded = settings.data
		if (!loaded) return
		setDraft({
			domain: loaded.dashboard_domain,
			https: loaded.dashboard_https,
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
	const saveButton = <SaveButton pending={save.isPending} />

	return (
		<div className='max-w-3xl'>
			<ErrorText error={save.error} />
			<FormSection
				title='Dashboard domain'
				description='Serve the panel on your own hostname with HTTPS.'
				icon={IconWorld}
				hint='Leave empty to keep using the server IP on port 3000.'
				actions={saveButton}
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
				title='Chart colour'
				description='The accent the charts draw in.'
				icon={IconPalette}
				hint='The rest of the panel stays monochrome.'
				actions={saveButton}
				onSave={apply}
			>
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
									'size-6 cursor-pointer rounded-full',
									selected && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
								)}
							/>
						)
					})}
				</div>
			</FormSection>

			<FormSection
				title='DNS challenge'
				description='Required for wildcard certificates.'
				icon={IconCloud}
				hint={
					tokenStored
						? 'A token is stored. Enter a new one to replace it.'
						: 'Scoped to Zone:Read and DNS:Edit. Without it only HTTP-01 is used and *.example.com cannot be issued.'
				}
				actions={
					<>
						{tokenStored ? (
							<Button variant='ghost' onClick={() => save.mutate('')} disabled={save.isPending}>
								<IconTrash />
								Remove token
							</Button>
						) : null}
						{saveButton}
					</>
				}
				onSave={apply}
			>
				<Field label='Cloudflare API token'>
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
