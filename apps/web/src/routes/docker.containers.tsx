import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { since } from '../lib/format'
import { Button, Cell, ErrorText, Page, Row, Section, Skeleton, Status, Table } from '../components/primitives'
import { LogViewer } from '../components/log-viewer'

export const Route = createFileRoute('/docker/containers')({ component: ContainersPage })

/**
 * Every container on the host, managed or not. Foreign stacks are visible but
 * clearly marked: the platform does not take them over.
 */
function ContainersPage() {
  const queryClient = useQueryClient()
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [onlyManaged, setOnlyManaged] = useState(false)

  const containers = useQuery({
    queryKey: ['containers'],
    queryFn: api.containers,
    refetchInterval: 5_000,
  })

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' | 'remove' }) =>
      api.containerAction(id, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['containers'] }),
  })

  const rows = (containers.data ?? []).filter((container) => !onlyManaged || container.managed)

  return (
    <Page title="Containers">
      <Section
        title="All containers"
        description={`${rows.length} shown`}
        actions={
          <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <input
              type="checkbox"
              className="!w-auto"
              checked={onlyManaged}
              onChange={(event) => setOnlyManaged(event.target.checked)}
            />
            managed only
          </label>
        }
      >
        <ErrorText error={act.error} />
        {containers.isLoading ? (
          <Skeleton rows={5} />
        ) : (
          <Table head={['Name', 'State', 'Image', 'Project', 'Created', '']}>
            {rows.map((container) => (
              <Row key={container.id}>
                <Cell mono>
                  {container.names[0]?.replace(/^\//, '') ?? container.id.slice(0, 12)}
                  {container.managed ? null : <span className="ml-2 text-[11px] text-zinc-600">external</span>}
                </Cell>
                <Cell>
                  <Status value={container.state} />
                </Cell>
                <Cell mono>{container.image}</Cell>
                <Cell mono>{container.project || '-'}</Cell>
                <Cell>{since(container.created)}</Cell>
                <Cell right>
                  <span className="flex justify-end gap-1.5">
                    <Button variant="ghost" onClick={() => setLogsFor(container.id)}>
                      logs
                    </Button>
                    <Button variant="ghost" onClick={() => act.mutate({ id: container.id, action: 'restart' })}>
                      restart
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        act.mutate({ id: container.id, action: container.state === 'running' ? 'stop' : 'start' })
                      }
                    >
                      {container.state === 'running' ? 'stop' : 'start'}
                    </Button>
                  </span>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>

      {logsFor ? (
        <Section
          title="Logs"
          actions={
            <Button variant="ghost" onClick={() => setLogsFor(null)}>
              close
            </Button>
          }
        >
          <LogViewer key={logsFor} url={`/api/docker/containers/${logsFor}/logs`} />
        </Section>
      ) : null}
    </Page>
  )
}
