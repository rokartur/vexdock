import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { since } from '../lib/format'
import { Button, Cell, Empty, Row, Section, Skeleton, Status, Table } from '../components/ui'

export const Route = createFileRoute('/projects/$projectId/')({ component: ProjectServices })

function ProjectServices() {
  const { projectId } = Route.useParams()
  const queryClient = useQueryClient()

  const services = useQuery({
    queryKey: ['services', projectId],
    queryFn: () => api.services(projectId),
    refetchInterval: 5_000,
  })

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
      api.serviceAction(id, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['services', projectId] }),
  })

  return (
    <Section title="Services" description={`${services.data?.length ?? 0} defined in compose`}>
      {services.isLoading ? (
        <Skeleton />
      ) : services.data?.length === 0 ? (
        <Empty>No services yet. Deploy the project to create them from its compose file.</Empty>
      ) : (
        <Table head={['Service', 'State', 'Health', 'Image', 'Restarts', 'Created', '']}>
          {services.data?.map((service) => (
            <Row key={service.id}>
              <Cell>
                <Link
                  to="/projects/$projectId/services/$serviceId"
                  params={{ projectId, serviceId: service.id }}
                  className="hover:underline"
                >
                  {service.compose_service_name}
                </Link>
              </Cell>
              <Cell>
                <Status value={service.state || 'stopped'} />
              </Cell>
              <Cell>{service.health ? <Status value={service.health} /> : <span className="text-[#5a5a5a]">-</span>}</Cell>
              <Cell mono>{service.image || '-'}</Cell>
              <Cell mono>{service.restart_count}</Cell>
              <Cell>{service.created_unix ? since(service.created_unix) : '-'}</Cell>
              <Cell right>
                <span className="flex justify-end gap-1.5">
                  <Button variant="ghost" onClick={() => act.mutate({ id: service.id, action: 'start' })}>
                    start
                  </Button>
                  <Button variant="ghost" onClick={() => act.mutate({ id: service.id, action: 'restart' })}>
                    restart
                  </Button>
                  <Button variant="ghost" onClick={() => act.mutate({ id: service.id, action: 'stop' })}>
                    stop
                  </Button>
                </span>
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </Section>
  )
}
