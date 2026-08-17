import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { Button, Cell, Empty, ErrorText, Field, Row, Section, Skeleton, Status, Table } from '../components/ui'

export const Route = createFileRoute('/projects/$projectId/domains')({ component: ProjectDomains })

function ProjectDomains() {
  const { projectId } = Route.useParams()
  const queryClient = useQueryClient()
  const [warning, setWarning] = useState('')

  const domains = useQuery({ queryKey: ['domains', projectId], queryFn: () => api.projectDomains(projectId) })
  const services = useQuery({ queryKey: ['services', projectId], queryFn: () => api.services(projectId) })
  const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })

  const [hostname, setHostname] = useState('')
  const [service, setService] = useState('')
  const [port, setPort] = useState(3000)
  const [https, setHttps] = useState(true)
  const [redirect, setRedirect] = useState(true)

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['domains', projectId] })
    await queryClient.invalidateQueries({ queryKey: ['certificates'] })
  }

  const create = useMutation({
    mutationFn: () =>
      api.createDomain({
        project_id: projectId,
        service,
        hostname,
        container_port: port,
        https_enabled: https,
        redirect_https: redirect,
      }),
    onSuccess: async (result) => {
      setWarning(result.warning ?? '')
      setHostname('')
      await invalidate()
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDomain(id),
    onSuccess: invalidate,
  })

  const issue = useMutation({
    mutationFn: (id: string) => api.issueCertificate(id),
    onSuccess: invalidate,
  })

  const certificateFor = (domainId: string) => certificates.data?.find((cert) => cert.domain_id === domainId)

  return (
    <>
      <Section title="Domains" description="the platform generates and reloads Nginx for you">
        {domains.isLoading ? (
          <Skeleton rows={2} />
        ) : domains.data?.length === 0 ? (
          <Empty>No domains yet. Point an A record at this server, then add it below.</Empty>
        ) : (
          <Table head={['Domain', 'Service', 'Port', 'HTTPS', 'Certificate', '']}>
            {domains.data?.map((domain) => {
              const certificate = certificateFor(domain.id)
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
                  <Cell mono>
                    {services.data?.find((item) => item.id === domain.service_id)?.compose_service_name ?? '-'}
                  </Cell>
                  <Cell mono>{domain.container_port}</Cell>
                  <Cell>{domain.https_enabled ? 'on' : 'off'}</Cell>
                  <Cell>
                    {certificate ? (
                      <span className="flex items-center gap-2">
                        <Status value={certificate.status} />
                        {certificate.expires_at ? (
                          <span className="text-[11px] text-[#8a8a8a]">
                            until {certificate.expires_at.slice(0, 10)}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-[#5a5a5a]">none</span>
                    )}
                  </Cell>
                  <Cell right>
                    <span className="flex justify-end gap-1.5">
                      {domain.https_enabled ? (
                        <Button variant="ghost" onClick={() => issue.mutate(domain.id)} disabled={issue.isPending}>
                          renew
                        </Button>
                      ) : null}
                      <Button variant="ghost" onClick={() => remove.mutate(domain.id)}>
                        remove
                      </Button>
                    </span>
                  </Cell>
                </Row>
              )
            })}
          </Table>
        )}
        <ErrorText error={remove.error ?? issue.error} />
        {certificates.data?.some((cert) => cert.status === 'failed') ? (
          <p className="pt-2 text-[12px] text-[#f5c451]">
            {certificates.data.find((cert) => cert.status === 'failed')?.last_error}
          </p>
        ) : null}
      </Section>

      <Section title="Add domain">
        <form
          className="grid gap-x-6 border-t border-[#1f1f1f] pt-3 md:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <Field label="Domain">
            <input
              required
              placeholder="app.example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
            />
          </Field>
          <Field label="Service">
            <select required value={service} onChange={(event) => setService(event.target.value)}>
              <option value="">Select…</option>
              {services.data?.map((item) => (
                <option key={item.id} value={item.compose_service_name}>
                  {item.compose_service_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Container port">
            <input
              type="number"
              required
              min={1}
              max={65535}
              value={port}
              onChange={(event) => setPort(Number(event.target.value))}
            />
          </Field>
          <div className="flex flex-col justify-center gap-1.5 pb-3">
            <label className="flex items-center gap-1.5 text-[12px]">
              <input
                type="checkbox"
                className="!w-auto"
                checked={https}
                onChange={(event) => setHttps(event.target.checked)}
              />
              HTTPS with Let&apos;s Encrypt
            </label>
            <label className="flex items-center gap-1.5 text-[12px]">
              <input
                type="checkbox"
                className="!w-auto"
                checked={redirect}
                disabled={!https}
                onChange={(event) => setRedirect(event.target.checked)}
              />
              Redirect HTTP to HTTPS
            </label>
          </div>
          <div className="md:col-span-4">
            <ErrorText error={create.error} />
            {warning ? <p className="pb-2 text-[12px] text-[#f5c451]">{warning}</p> : null}
            <Button type="submit" variant="primary" disabled={create.isPending}>
              {create.isPending ? 'Adding…' : 'Add domain'}
            </Button>
          </div>
        </form>
      </Section>
    </>
  )
}
