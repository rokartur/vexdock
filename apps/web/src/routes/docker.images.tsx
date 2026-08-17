import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { bytes, since } from '../lib/format'
import { Button, Cell, ErrorText, Page, Row, Section, Skeleton, Table } from '../components/primitives'

export const Route = createFileRoute('/docker/images')({ component: ImagesPage })

function ImagesPage() {
  const queryClient = useQueryClient()
  const [reference, setReference] = useState('')

  const images = useQuery({ queryKey: ['images'], queryFn: api.images })

  const pull = useMutation({
    mutationFn: () => api.pullImage(reference),
    onSuccess: async () => {
      setReference('')
      await queryClient.invalidateQueries({ queryKey: ['images'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.removeImage(id, false),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['images'] }),
  })

  return (
    <Page title="Images">

      <Section title="Pull image">
        <form
          className="flex gap-2 border-t border-border pt-3"
          onSubmit={(event) => {
            event.preventDefault()
            pull.mutate()
          }}
        >
          <input
            required
            value={reference}
            placeholder="ghcr.io/user/app:latest"
            onChange={(event) => setReference(event.target.value)}
            className="max-w-md font-mono text-[13px]"
          />
          <Button type="submit" variant="primary" disabled={pull.isPending}>
            {pull.isPending ? 'Pulling…' : 'Pull'}
          </Button>
        </form>
        <ErrorText error={pull.error} />
      </Section>

      <Section title="Local images" description={`${images.data?.length ?? 0} total`}>
        <ErrorText error={remove.error} />
        {images.isLoading ? (
          <Skeleton rows={5} />
        ) : (
          <Table head={['Repository', 'Size', 'Containers', 'Created', '']}>
            {images.data?.map((image) => (
              <Row key={image.Id}>
                <Cell mono>{image.RepoTags?.join(', ') || image.Id.replace('sha256:', '').slice(0, 12)}</Cell>
                <Cell mono>{bytes(image.Size)}</Cell>
                <Cell mono>{image.Containers < 0 ? '-' : image.Containers}</Cell>
                <Cell>{since(image.Created)}</Cell>
                <Cell right>
                  <Button variant="ghost" onClick={() => remove.mutate(image.Id)}>
                    remove
                  </Button>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>
    </Page>
  )
}
