import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { api } from '../lib/api'
import { duration, shortSha, since } from '../lib/format'
import { Button, Cell, Empty, ErrorText, Row, Section, Skeleton, Status, Table } from '../components/ui'

export const Route = createFileRoute('/projects/$projectId/deployments')({ component: ProjectDeployments })

function ProjectDeployments() {
  const { projectId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const deployments = useQuery({
    queryKey: ['deployments', projectId],
    queryFn: () => api.deployments(projectId),
    refetchInterval: 5_000,
  })

  const rollback = useMutation({
    mutationFn: (id: string) => api.rollback(id),
    onSuccess: async (deployment) => {
      await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] })
      await navigate({ to: '/deployments/$deploymentId', params: { deploymentId: deployment.id } })
    },
  })

  return (
    <Section title="Deployment history">
      <ErrorText error={rollback.error} />
      {deployments.isLoading ? (
        <Skeleton />
      ) : deployments.data?.length === 0 ? (
        <Empty>No deployments yet.</Empty>
      ) : (
        <Table head={['#', 'Status', 'Branch', 'Commit', 'Trigger', 'Duration', 'When', '']}>
          {deployments.data?.map((deployment) => (
            <Row key={deployment.id}>
              <Cell mono>
                <Link
                  to="/deployments/$deploymentId"
                  params={{ deploymentId: deployment.id }}
                  className="hover:underline"
                >
                  #{deployment.number}
                </Link>
              </Cell>
              <Cell>
                <Status value={deployment.status} />
              </Cell>
              <Cell mono>{deployment.branch}</Cell>
              <Cell mono>{shortSha(deployment.commit_sha)}</Cell>
              <Cell>{deployment.trigger}</Cell>
              <Cell mono>{duration(deployment.started_at, deployment.finished_at)}</Cell>
              <Cell>{since(deployment.created_at)}</Cell>
              <Cell right>
                {deployment.commit_sha && deployment.status === 'success' ? (
                  <Button variant="ghost" onClick={() => rollback.mutate(deployment.id)} title="Redeploy this commit">
                    redeploy this
                  </Button>
                ) : null}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </Section>
  )
}
