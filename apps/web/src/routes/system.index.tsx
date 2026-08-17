import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { bytes, since } from '../lib/format'
import { Cell, Page, Row, Section, Skeleton, Status, Table } from '../components/primitives'

export const Route = createFileRoute('/system/')({ component: SystemOverview })

function SystemOverview() {
  const info = useQuery({ queryKey: ['system', 'info'], queryFn: api.systemInfo })
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 })
  const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })
  const audit = useQuery({ queryKey: ['audit'], queryFn: api.audit, refetchInterval: 30_000 })

  return (
    <Page title="System">

      <Section title="Health">
        {health.isLoading ? (
          <Skeleton rows={3} />
        ) : (
          <Table head={['Check', 'Result']}>
            {Object.entries(health.data?.checks ?? {}).map(([name, result]) => (
              <Row key={name}>
                <Cell mono>{name}</Cell>
                <Cell>{result === 'ok' ? <Status value="healthy" /> : <span className="text-destructive">{result}</span>}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Host">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-1 border-t border-border pt-2 lg:grid-cols-4">
          <Item label="Platform version" value={info.data?.version ?? '-'} />
          <Item label="Docker" value={info.data?.host.docker_version ?? '-'} />
          <Item label="OS" value={info.data?.host.os ?? '-'} />
          <Item label="Architecture" value={info.data?.host.architecture ?? '-'} />
          <Item label="CPUs" value={String(info.data?.host.cpus ?? '-')} />
          <Item label="Memory" value={bytes(info.data?.host.memory_total)} />
          <Item label="Containers" value={`${info.data?.containers_running ?? 0} / ${info.data?.containers ?? 0}`} />
          <Item label="Images" value={String(info.data?.images ?? 0)} />
        </dl>
      </Section>

      <Section title="Certificates">
        {certificates.data?.length === 0 ? (
          <p className="border-t border-border py-6 text-[13px] text-muted-foreground">
            No certificates issued yet.
          </p>
        ) : (
          <Table head={['Domain', 'Issuer', 'Status', 'Expires', 'Last renewed']}>
            {certificates.data?.map((certificate) => (
              <Row key={certificate.id}>
                <Cell mono>{certificate.hostname}</Cell>
                <Cell>{certificate.issuer || '-'}</Cell>
                <Cell>
                  <Status value={certificate.status} />
                </Cell>
                <Cell mono>{certificate.expires_at ? certificate.expires_at.slice(0, 10) : '-'}</Cell>
                <Cell mono>{certificate.last_renewed_at ? certificate.last_renewed_at.slice(0, 10) : '-'}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>
      <Section title="Audit" description="every state-changing call, newest first">
        {audit.isLoading ? (
          <Skeleton rows={4} />
        ) : audit.data?.length === 0 ? (
          <p className="text-muted-foreground border-t py-6 text-xs">Nothing recorded yet.</p>
        ) : (
          <Table head={['When', 'Actor', 'Action', 'Status', 'Via', 'From']}>
            {audit.data?.map((entry) => (
              <Row key={entry.id}>
                <Cell>{since(entry.at)}</Cell>
                <Cell>{entry.actor}</Cell>
                <Cell mono>
                  {entry.method} {entry.path}
                </Cell>
                <Cell mono>{entry.status}</Cell>
                <Cell>{entry.credential}</Cell>
                <Cell mono>{entry.client_ip || '-'}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>
    </Page>
  )
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1">
      <dt className="text-[12px] tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="font-mono text-[13px] break-all">{value}</dd>
    </div>
  )
}
