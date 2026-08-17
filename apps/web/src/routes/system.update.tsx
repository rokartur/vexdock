import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { Button, ErrorText, Section } from '../components/primitives'

export const Route = createFileRoute('/system/update')({ component: UpdatePage })

function UpdatePage() {
  const [message, setMessage] = useState('')
  const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })

  const update = useMutation({
    mutationFn: () => api.update(version.data?.latest),
    onSuccess: (result) => setMessage(result.message),
  })

  return (
    <>
      <h1 className="mb-5 text-[15px] font-medium">Update</h1>
      <Section title="Version">
        <dl className="grid grid-cols-2 gap-x-8 border-t border-[#1f1f1f] pt-2">
          <div className="py-1">
            <dt className="text-[11px] tracking-wide text-[#8a8a8a] uppercase">Installed</dt>
            <dd className="font-mono text-[13px]">{version.data?.current ?? '-'}</dd>
          </div>
          <div className="py-1">
            <dt className="text-[11px] tracking-wide text-[#8a8a8a] uppercase">Latest</dt>
            <dd className="font-mono text-[13px]">{version.data?.latest || 'unknown'}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Actions" description="a backup is taken before the swap and rolled back if health fails">
        <div className="border-t border-[#1f1f1f] pt-3">
          <ErrorText error={update.error} />
          {message ? <p className="pb-2 text-[12px] text-[#3ddc84]">{message}</p> : null}
          <Button
            variant="primary"
            onClick={() => update.mutate()}
            disabled={update.isPending || !version.data?.update_available}
          >
            {version.data?.update_available ? `Update to ${version.data.latest}` : 'Up to date'}
          </Button>
        </div>
      </Section>
    </>
  )
}
