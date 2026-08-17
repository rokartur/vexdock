import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { api, type CredentialKind } from '../lib/api'
import { Button, ErrorText, Field, Section } from '../components/ui'

export const Route = createFileRoute('/projects/$projectId/settings')({ component: ProjectSettings })

function ProjectSettings() {
  const { projectId } = Route.useParams()
  const queryClient = useQueryClient()
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) })
  const compose = useQuery({ queryKey: ['compose', projectId], queryFn: () => api.compose(projectId) })

  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const [composePath, setComposePath] = useState('')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [autoDeploy, setAutoDeploy] = useState(false)
  const [credentialKind, setCredentialKind] = useState<CredentialKind>('none')
  const [credentialSecret, setCredentialSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [composeContent, setComposeContent] = useState('')

  useEffect(() => {
    if (!project.data) return
    setName(project.data.name)
    setBranch(project.data.branch)
    setComposePath(project.data.compose_path)
    setRepositoryUrl(project.data.repository_url)
    setAutoDeploy(project.data.auto_deploy)
    setCredentialKind(project.data.git_credential_kind)
  }, [project.data])

  useEffect(() => {
    if (compose.data) setComposeContent(compose.data.content)
  }, [compose.data])

  const save = useMutation({
    mutationFn: () =>
      api.updateProject(projectId, {
        name,
        branch,
        compose_path: composePath,
        repository_url: repositoryUrl,
        auto_deploy: autoDeploy,
        credential_kind: credentialKind,
        credential_secret: credentialSecret,
        // Only send the webhook secret when the field was actually touched, so
        // saving other settings never clears it.
        ...(webhookSecret === '' ? {} : { webhook_secret: webhookSecret }),
      }),
    onSuccess: () => {
      setCredentialSecret('')
      setWebhookSecret('')
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const saveCompose = useMutation({
    mutationFn: () => api.saveCompose(projectId, composeContent),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compose', projectId] }),
  })

  const isGit = project.data?.source_type === 'git'

  return (
    <>
      <Section title="Project">
        <div className="grid gap-x-6 border-t border-[#1f1f1f] pt-3 md:grid-cols-2">
          <Field label="Name">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          {isGit ? (
            <>
              <Field label="Repository URL">
                <input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} />
              </Field>
              <Field label="Branch">
                <input value={branch} onChange={(event) => setBranch(event.target.value)} />
              </Field>
              <Field label="Compose file">
                <input value={composePath} onChange={(event) => setComposePath(event.target.value)} />
              </Field>
              <Field label="Credentials">
                <select
                  value={credentialKind}
                  onChange={(event) => setCredentialKind(event.target.value as CredentialKind)}
                >
                  <option value="none">Public repository</option>
                  <option value="token">Access token</option>
                  <option value="ssh_key">SSH private key</option>
                </select>
              </Field>
              {credentialKind !== 'none' ? (
                <Field
                  label={credentialKind === 'token' ? 'Token' : 'Private key'}
                  hint="Leave empty to keep the stored value."
                >
                  <textarea
                    rows={credentialKind === 'token' ? 1 : 5}
                    value={credentialSecret}
                    onChange={(event) => setCredentialSecret(event.target.value)}
                    className="font-mono text-[12px]"
                  />
                </Field>
              ) : null}
            </>
          ) : null}
        </div>
        {isGit ? (
          <label className="mb-3 flex items-center gap-1.5 text-[12px]">
            <input
              type="checkbox"
              className="!w-auto"
              checked={autoDeploy}
              onChange={(event) => setAutoDeploy(event.target.checked)}
            />
            Deploy automatically when the branch is pushed
          </label>
        ) : null}
        <ErrorText error={save.error} />
        <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </Section>

      {isGit ? (
        <Section title="Webhook" description="point your git provider here to auto deploy">
          <code className="block border-t border-[#1f1f1f] pt-2 font-mono text-[12px] break-all text-[#c4c4c4]">
            {project.data?.webhook_url}
          </code>
          <div className="mt-3 max-w-md">
            <Field
              label="Signing secret"
              hint={
                project.data?.webhook_secret_set
                  ? 'A secret is set. Enter a new one to replace it, or a single space to disable verification.'
                  : 'Optional. When set, X-Hub-Signature-256 must match or the request is rejected.'
              }
            >
              <input
                type="password"
                value={webhookSecret}
                onChange={(event) => setWebhookSecret(event.target.value)}
              />
            </Field>
            <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
              Save webhook secret
            </Button>
          </div>
        </Section>
      ) : (
        <Section
          title="Compose file"
          actions={
            <Button variant="primary" onClick={() => saveCompose.mutate()} disabled={saveCompose.isPending}>
              {saveCompose.isPending ? 'Saving…' : 'Save compose'}
            </Button>
          }
        >
          <ErrorText error={saveCompose.error} />
          <textarea
            rows={18}
            value={composeContent}
            onChange={(event) => setComposeContent(event.target.value)}
            className="font-mono text-[12px]"
            spellCheck={false}
          />
        </Section>
      )}
    </>
  )
}
