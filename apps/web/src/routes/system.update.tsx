import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, ErrorText, Page, Section } from '../components/primitives'
import { api } from '../lib/api'

export const Route = createFileRoute('/system/update')({ component: UpdatePage })

function UpdatePage() {
	const [message, setMessage] = useState('')
	const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })

	const update = useMutation({
		mutationFn: () => api.update(version.data?.latest),
		onSuccess: result => setMessage(result.message),
	})

	return (
		<Page title='Update'>
			<Section title='Version'>
				<dl className='grid grid-cols-2 gap-x-8 border-t border-border pt-2'>
					<div className='py-1'>
						<dt className='text-label tracking-wide text-muted-foreground uppercase'>Installed</dt>
						<dd className='font-mono text-title'>{version.data?.current ?? '-'}</dd>
					</div>
					<div className='py-1'>
						<dt className='text-label tracking-wide text-muted-foreground uppercase'>Latest</dt>
						<dd className='font-mono text-title'>{version.data?.latest || 'unknown'}</dd>
					</div>
				</dl>
			</Section>

			<Section title='Actions' description='a backup is taken before the swap and rolled back if health fails'>
				<div className='border-t border-border pt-3'>
					<ErrorText error={update.error} />
					{message ? <p className='pb-2 text-body text-emerald-400'>{message}</p> : null}
					<Button
						variant='primary'
						onClick={() => update.mutate()}
						disabled={update.isPending || !version.data?.update_available}
					>
						{version.data?.update_available ? `Update to ${version.data.latest}` : 'Up to date'}
					</Button>
				</div>
			</Section>
		</Page>
	)
}
