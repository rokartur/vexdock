import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { Cell, Empty, Row, Section, Skeleton, Status, Table } from '../components/primitives'

export const Route = createFileRoute('/domains')({ component: DomainsPage })

function DomainsPage() {
  const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })

  return (
    <>
      <h1 className="mb-5 text-[15px] font-medium">Domains</h1>
      <Section title="All domains" description="add and edit them inside a project">
        {domains.isLoading ? (
          <Skeleton />
        ) : domains.data?.length === 0 ? (
          <Empty>No domains configured yet.</Empty>
        ) : (
          <Table head={['Domain', 'Project', 'Port', 'HTTPS', 'Certificate', 'Expires']}>
            {domains.data?.map((domain) => {
              const certificate = certificates.data?.find((item) => item.domain_id === domain.id)
              const project = projects.data?.find((item) => item.id === domain.project_id)
              return (
                <Row key={domain.id}>
                  <Cell mono>
                    <a
                      href={`${domain.https_enabled ? 'https' : 'http'}://${domain.hostname}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {domain.hostname}
                    </a>
                  </Cell>
                  <Cell>
                    <Link
                      to="/projects/$projectId/domains"
                      params={{ projectId: domain.project_id }}
                      className="hover:underline"
                    >
                      {project?.name ?? domain.project_id}
                    </Link>
                  </Cell>
                  <Cell mono>{domain.container_port}</Cell>
                  <Cell>{domain.https_enabled ? 'on' : 'off'}</Cell>
                  <Cell>{certificate ? <Status value={certificate.status} /> : <span className="text-[#5a5a5a]">none</span>}</Cell>
                  <Cell mono>{certificate?.expires_at ? certificate.expires_at.slice(0, 10) : '-'}</Cell>
                </Row>
              )
            })}
          </Table>
        )}
      </Section>
    </>
  )
}
