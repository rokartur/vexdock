import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Check, ErrorText, Section } from '../components/primitives'
import { api, type VersionSettings } from '../lib/api'

export const Route = createFileRoute('/system/settings/about')({ component: Version })

/** Installed vs published build, and the in-place upgrade. */
function Version() {
	const [message, setMessage] = useState('')
	const queryClient = useQueryClient()
	const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })

	const setSettings = useMutation({
		mutationFn: api.setVersionSettings,
		onSuccess: data => {
			queryClient.setQueryData(['version'], data)
			setMessage('')
		},
	})

	const update = useMutation({
		mutationFn: () => api.update(version.data?.latest),
		onSuccess: result => setMessage(result.message),
	})

	// The endpoint takes the whole preference set, so a toggle carries the
	// other one along.
	const save = (patch: Partial<VersionSettings>) => {
		if (!version.data) return
		const { beta, cleanup_old_images } = version.data
		setSettings.mutate({ beta, cleanup_old_images, ...patch })
	}

	return (
		<Section title='Version' description='a backup is taken before the swap and rolled back if health fails'>
			<div className='flex max-w-2xl flex-col gap-4'>
				<div className='flex items-center gap-10'>
					<dl className='flex gap-10'>
						<div>
							<dt className='text-label tracking-wide text-muted-foreground uppercase'>Installed</dt>
							<dd className='font-mono text-title'>{version.data?.current ?? '-'}</dd>
						</div>
						<div>
							<dt className='text-label tracking-wide text-muted-foreground uppercase'>Latest</dt>
							<dd
								className={`font-mono text-title ${version.data?.update_available ? 'text-emerald-400' : ''}`}
							>
								{version.data?.latest || 'unknown'}
							</dd>
						</div>
					</dl>
					<Button
						variant='primary'
						onClick={() => update.mutate()}
						disabled={update.isPending || !version.data?.update_available}
					>
						{version.data?.update_available ? `Update to ${version.data.latest}` : 'Up to date'}
					</Button>
				</div>
				<Check
					label='Include beta releases'
					checked={version.data?.beta ?? false}
					disabled={setSettings.isPending || version.isLoading}
					onChange={beta => save({ beta })}
				/>
				<Check
					label='Remove previous version images after a successful update'
					checked={version.data?.cleanup_old_images ?? false}
					disabled={setSettings.isPending || version.isLoading || update.isPending}
					onChange={cleanup_old_images => save({ cleanup_old_images })}
				/>
			</div>
			<ErrorText error={update.error ?? setSettings.error} />
			{message ? <p className='pt-2 text-body text-emerald-400'>{message}</p> : null}
		</Section>
	)
}
