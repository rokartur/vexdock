import { useMemo, useState } from 'react'
import {
	IconBell,
	IconCreditCard,
	IconLink,
	IconMessageCircle,
	IconPlus,
	IconShare,
	IconShieldOff,
	IconTrash,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CopyButton } from '@/components/ui/copy-button'
import { Skeleton } from '@/components/ui/skeleton'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormDialog,
	FormSection,
	IconButton,
	Input,
	SaveButton,
	Section,
	Switch,
	Textarea,
} from '../components/primitives'
import { type AnalyticsSettings, type AnalyticsSettingsUpdate, type ShortLink, api } from '../lib/api'
import { analyticsSitesQuery } from '../lib/queries'

export const Route = createFileRoute('/analytics/$domainId/settings')({ component: SiteSettings })

function useSettings(domainId: string) {
	const queryClient = useQueryClient()
	const key = ['analytics', domainId, 'settings']
	const settings = useQuery({ queryKey: key, queryFn: () => api.analyticsSettings(domainId) })
	const save = useMutation({
		mutationFn: (changes: AnalyticsSettingsUpdate) => api.updateAnalyticsSettings(domainId, changes),
		onSuccess: next => queryClient.setQueryData(key, next),
	})
	return { settings, save }
}

function SiteSettings() {
	const { domainId } = Route.useParams()
	const { settings } = useSettings(domainId)
	const sites = useQuery(analyticsSitesQuery)
	const domain = sites.data?.find(site => site.domain.id === domainId)?.domain

	if (!settings.data) {
		return settings.error ? (
			<ErrorText error={settings.error} />
		) : (
			<Skeleton label='Loading settings' className='p-5' />
		)
	}
	const siteOrigin = domain ? `${domain.https_enabled ? 'https' : 'http'}://${domain.hostname}` : ''
	return (
		<div>
			<Sharing domainId={domainId} current={settings.data} />
			<Notifications domainId={domainId} current={settings.data} />
			<Providers domainId={domainId} current={settings.data} />
			<Mentions domainId={domainId} current={settings.data} />
			<Exclusions domainId={domainId} current={settings.data} />
			<ShortLinks domainId={domainId} siteOrigin={siteOrigin} />
		</div>
	)
}

type CardProps = { domainId: string; current: AnalyticsSettings }

function Sharing({ domainId, current }: CardProps) {
	const { save } = useSettings(domainId)
	const url = current.share_token ? `${window.location.origin}/shared/${current.share_token}` : ''
	return (
		<FormSection
			title='Public dashboard'
			icon={IconShare}
			hint='Anyone with the link sees the totals, the chart and the breakdowns. Never the visitors, the live feed or these settings.'
			actions={
				url ? (
					<Confirm
						title='Revoke the public link?'
						description='The link stops working. A new one is a different address.'
						action='Revoke'
						onConfirm={() => save.mutate({ share: false })}
					>
						<Button variant='danger'>Revoke</Button>
					</Confirm>
				) : (
					<Button onClick={() => save.mutate({ share: true })} disabled={save.isPending}>
						<IconLink size={16} stroke={1.75} />
						Create link
					</Button>
				)
			}
		>
			<ErrorText error={save.error} />
			{url ? (
				<span className='flex items-center gap-2'>
					<a
						href={url}
						target='_blank'
						rel='noreferrer'
						className='min-w-0 font-mono text-xs break-all hover:underline'
					>
						{url}
					</a>
					<CopyButton value={url} label='Copy link' iconOnly variant='plain' />
				</span>
			) : (
				<p className='text-sm text-muted'>Not shared.</p>
			)}
		</FormSection>
	)
}

function Notifications({ domainId, current }: CardProps) {
	const { save } = useSettings(domainId)
	const [url, setUrl] = useState(current.notify_url)
	return (
		<FormSection
			title='Notifications'
			icon={IconBell}
			hint='A Slack or Discord incoming webhook. It gets a message for every payment and, once a week, the last seven days against the seven before.'
			onSave={() => save.mutate({ notify_url: url.trim() })}
			actions={<SaveButton mutation={save} dirty={url.trim() !== current.notify_url} />}
		>
			<ErrorText error={save.error} />
			<Field label='Webhook URL'>
				<Input
					mono
					type='url'
					placeholder='https://hooks.slack.com/services/…'
					value={url}
					onChange={event => setUrl(event.target.value)}
				/>
			</Field>
		</FormSection>
	)
}

const providers = [
	{
		id: 'stripe',
		label: 'Stripe',
		hint: 'Signing secret, whsec_…; events checkout.session.completed, checkout.session.async_payment_succeeded and invoice.paid',
	},
	{
		id: 'lemonsqueezy',
		label: 'Lemon Squeezy',
		hint: 'Signing secret; events order_created and subscription_payment_success',
	},
	{ id: 'paddle', label: 'Paddle', hint: 'Secret key, pdl_ntfset_…; event transaction.completed' },
	{ id: 'polar', label: 'Polar', hint: 'Webhook secret; event order.paid' },
] as const

function Providers({ domainId, current }: CardProps) {
	const { save } = useSettings(domainId)
	const [secrets, setSecrets] = useState<Record<string, string>>({})
	const changes: AnalyticsSettingsUpdate = {}
	for (const provider of providers) {
		const value = secrets[provider.id]?.trim()
		if (value) changes[`${provider.id}_secret`] = value
	}
	return (
		<FormSection
			title='Payment providers'
			icon={IconCreditCard}
			hint={
				<>
					Point the provider&apos;s webhook at its URL and pass the visitor&apos;s{' '}
					<code className='font-mono text-xs'>vx_vid</code> cookie as{' '}
					<code className='font-mono text-xs'>vx_visitor_id</code> in the checkout&apos;s metadata.
				</>
			}
			onSave={() => save.mutate(changes, { onSuccess: () => setSecrets({}) })}
			actions={<SaveButton mutation={save} dirty={Object.keys(changes).length > 0} />}
		>
			<ErrorText error={save.error} />
			<div className='flex flex-col gap-4'>
				{providers.map(provider => {
					const set = current.providers[provider.id]
					const url = `${current.webhook_origin}/api/analytics/webhooks/${provider.id}/${domainId}`
					return (
						<div key={provider.id} className='flex flex-col gap-2'>
							<span className='flex items-center gap-2 text-sm'>
								<span className='font-medium'>{provider.label}</span>
								<span className='min-w-0 truncate font-mono text-xs text-muted'>{url}</span>
								<CopyButton
									value={url}
									label={`Copy the ${provider.label} webhook URL`}
									iconOnly
									variant='plain'
								/>
								{set ? (
									<Confirm
										title={`Disconnect ${provider.label}?`}
										description='Its webhook answers 404 until a secret is saved again.'
										action='Disconnect'
										onConfirm={() => save.mutate({ [`${provider.id}_secret`]: '' })}
									>
										<IconButton label={`Disconnect ${provider.label}`} icon={IconTrash} />
									</Confirm>
								) : null}
							</span>
							<Field
								label={
									set
										? `${provider.label} secret (saved; type to replace)`
										: `${provider.label} secret`
								}
								hint={provider.hint}
							>
								<Input
									mono
									type='password'
									autoComplete='off'
									value={secrets[provider.id] ?? ''}
									onChange={event => setSecrets({ ...secrets, [provider.id]: event.target.value })}
								/>
							</Field>
						</div>
					)
				})}
			</div>
		</FormSection>
	)
}

function Mentions({ domainId, current }: CardProps) {
	const { save } = useSettings(domainId)
	const [token, setToken] = useState('')
	return (
		<FormSection
			title='Mentions'
			icon={IconMessageCircle}
			hint='Every six hours, posts linking to the site become annotations on the chart. X needs your own API bearer token on a paid tier.'
			onSave={() => save.mutate({ x_token: token.trim() }, { onSuccess: () => setToken('') })}
			actions={<SaveButton mutation={save} dirty={token.trim() !== ''} />}
		>
			<ErrorText error={save.error} />
			<div className='flex flex-col gap-4'>
				<Switch
					label='Reddit'
					hint='Searches Reddit for links to the hostname.'
					checked={current.reddit}
					onChange={reddit => save.mutate({ reddit })}
				/>
				<span className='flex items-end gap-2'>
					<span className='flex-1'>
						<Field label={current.x_token ? 'X bearer token (saved; type to replace)' : 'X bearer token'}>
							<Input
								mono
								type='password'
								autoComplete='off'
								value={token}
								onChange={event => setToken(event.target.value)}
							/>
						</Field>
					</span>
					{current.x_token ? (
						<Confirm
							title='Remove the X token?'
							action='Remove'
							onConfirm={() => save.mutate({ x_token: '' })}
						>
							<IconButton label='Remove the X token' icon={IconTrash} />
						</Confirm>
					) : null}
				</span>
			</div>
		</FormSection>
	)
}

function Exclusions({ domainId, current }: CardProps) {
	const { save } = useSettings(domainId)
	const [ips, setIps] = useState(current.excluded_ips)
	return (
		<FormSection
			title='Excluded addresses'
			icon={IconShieldOff}
			hint='Visits from these IP addresses are not counted, one per line, at most 100. To leave out one browser instead, run localStorage.vx_ignore = "true" in its console on the site.'
			onSave={() => save.mutate({ excluded_ips: ips })}
			actions={<SaveButton mutation={save} dirty={ips.trim() !== current.excluded_ips} />}
		>
			<ErrorText error={save.error} />
			<Field label='IP addresses'>
				<Textarea mono rows={4} value={ips} onChange={event => setIps(event.target.value)} />
			</Field>
		</FormSection>
	)
}

function linkColumns(siteOrigin: string, onDelete: (slug: string) => void): Columns<ShortLink> {
	const cell = columnsFor<ShortLink>()
	return [
		cell.accessor('slug', {
			header: 'Link',
			cell: ({ getValue }) => {
				const url = `${siteOrigin}/_vx/l/${getValue()}`
				return (
					<span className='inline-flex items-center gap-2 font-mono text-xs'>
						{url}
						<CopyButton value={url} label='Copy link' iconOnly variant='plain' />
					</span>
				)
			},
		}),
		cell.accessor('target', { header: 'Target', meta: { mono: true } }),
		cell.accessor(link => [link.utm_source, link.utm_medium, link.utm_campaign].filter(Boolean).join(' / '), {
			id: 'utm',
			header: 'Source / medium / campaign',
		}),
		cell.display({
			id: 'actions',
			cell: ({ row }) => (
				<Confirm title={`Delete the ${row.original.slug} link?`} onConfirm={() => onDelete(row.original.slug)}>
					<IconButton label='Delete' icon={IconTrash} />
				</Confirm>
			),
		}),
	]
}

const blankLink = { slug: '', target: '', utm_source: '', utm_medium: '', utm_campaign: '' }

function ShortLinks({ domainId, siteOrigin }: { domainId: string; siteOrigin: string }) {
	const queryClient = useQueryClient()
	const key = ['analytics', domainId, 'links']
	const [open, setOpen] = useState(false)
	const [link, setLink] = useState(blankLink)
	const links = useQuery({ queryKey: key, queryFn: () => api.shortLinks(domainId) })
	const create = useMutation({
		mutationFn: () => api.createShortLink(domainId, link),
		onSuccess: () => {
			setOpen(false)
			setLink(blankLink)
			void queryClient.invalidateQueries({ queryKey: key })
		},
	})
	const remove = useMutation({
		mutationFn: (slug: string) => api.deleteShortLink(domainId, slug),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
	})
	const { mutate: removeLink } = remove
	const columns = useMemo(() => linkColumns(siteOrigin, removeLink), [siteOrigin, removeLink])
	const field = (name: keyof typeof blankLink) => ({
		value: link[name],
		onChange: (event: { target: { value: string } }) => setLink({ ...link, [name]: event.target.value }),
	})

	return (
		<Section
			title='Short links'
			total={links.data?.length ?? 0}
			actions={
				<Button onClick={() => setOpen(true)}>
					<IconPlus size={16} stroke={1.75} />
					Add link
				</Button>
			}
		>
			<ErrorText error={remove.error} />
			<DataTable
				data={links.data ?? []}
				columns={columns}
				loading={links.isLoading}
				error={links.error}
				getRowId={row => row.slug}
				empty="No short links. One on the site's own hostname tags every visit it brings with its campaign."
			/>
			<FormDialog
				open={open}
				onOpenChange={setOpen}
				title='Add a short link'
				description={`Served at ${siteOrigin}/_vx/l/<slug>; it redirects with the UTM parameters below.`}
				action='Add'
				icon={IconPlus}
				mutation={create}
				onSubmit={() => create.mutate()}
			>
				<div className='flex flex-col gap-3'>
					<Field label='Target URL'>
						<Input mono type='url' required placeholder={`${siteOrigin}/pricing`} {...field('target')} />
					</Field>
					<Field label='Slug' hint='Letters, digits, - and _; left empty, one is made up.'>
						<Input mono maxLength={64} {...field('slug')} />
					</Field>
					<Field label='utm_source'>
						<Input placeholder='x' {...field('utm_source')} />
					</Field>
					<Field label='utm_medium'>
						<Input placeholder='social' {...field('utm_medium')} />
					</Field>
					<Field label='utm_campaign'>
						<Input placeholder='launch' {...field('utm_campaign')} />
					</Field>
				</div>
			</FormDialog>
		</Section>
	)
}
