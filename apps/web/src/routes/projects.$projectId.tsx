import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../lib/api'
import { Button, ErrorText, Status } from '../components/primitives'

export const Route = createFileRoute('/projects/$projectId')({ component: ProjectLayout })

const tabs = [
  { suffix: '', label: 'Services' },
  { suffix: '/deployments', label: 'Deployments' },
  { suffix: '/domains', label: 'Domains' },
  { suffix: '/environment', label: 'Environment' },
  { suffix: '/settings', label: 'Settings' },
]

function ProjectLayout() {
  const { projectId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [confirmDelete, setConfirmDelete] = useState(false)

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.project(projectId),
    refetchInterval: 10_000,
  })

  const deploy = useMutation({
    mutationFn: () => api.deploy(projectId),
    onSuccess: async (deployment) => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      await navigate({ to: '/deployments/$deploymentId', params: { deploymentId: deployment.id } })
    },
  })

  const stop = useMutation({
    mutationFn: () => api.stopProject(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId, false),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      await navigate({ to: '/projects' })
    },
  })

  const base = `/projects/${projectId}`

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Link to="/projects" className="text-[12px] text-[#8a8a8a] hover:text-white">
            projects
          </Link>
          <span className="text-[#3a3a3a]">/</span>
          <h1 className="text-[15px] font-medium">{project.data?.name ?? projectId}</h1>
          {project.data?.latest_deployment ? <Status value={project.data.latest_deployment.status} /> : null}
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => deploy.mutate()} disabled={deploy.isPending}>
            {deploy.isPending ? 'Starting…' : 'Deploy'}
          </Button>
          <Button onClick={() => stop.mutate()} disabled={stop.isPending}>
            Stop
          </Button>
          {confirmDelete ? (
            <>
              <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Confirm delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
        </div>
      </div>

      <nav className="mb-5 flex gap-4 border-b border-[#1f1f1f]">
        {tabs.map((tab) => {
          const to = base + tab.suffix
          const active = tab.suffix === '' ? pathname === base || pathname === `${base}/` : pathname.startsWith(to)
          return (
            <Link
              key={tab.label}
              to={to}
              className={`-mb-px border-b px-0.5 pb-1.5 text-[12px] ${
                active ? 'border-white text-white' : 'border-transparent text-[#8a8a8a] hover:text-white'
              }`}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>

      <ErrorText error={deploy.error ?? stop.error ?? remove.error} />
      <Outlet />
    </>
  )
}
