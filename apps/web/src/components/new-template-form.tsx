import { useState } from 'react'
import { IconPlus } from '@tabler/icons-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { DialogFooter } from '@/components/ui/dialog'
import { api, type Service, type Template } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { Button, ErrorText, Field, Input } from './primitives'

/**
 * Installs a catalog application. The manager does the work: it creates one
 * service per compose service, seeds the passwords the stack needs and points
 * the domain at whichever service serves it. Nothing here knows the compose
 * files, so adding a template is a manager-side change alone.
 *
 * The services exist even when the domain fails, which is why a warning ends
 * the form rather than failing it.
 */
export function NewTemplateForm({
	projectId,
	onDone,
	onCancel,
}: {
	projectId: string
	onDone: (service: Service) => void
	onCancel: () => void
}) {
	const [slug, setSlug] = useState('')
	const [hostname, setHostname] = useState('')
	const [installed, setInstalled] = useState<{ service: Service; warning: string } | null>(null)

	const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates })
	const selected = templates.data?.find(template => template.slug === slug)

	const environmentId = useEnvironmentId()
	const install = useMutation({
		mutationFn: () => api.createFromTemplate(projectId, { slug, hostname }, environmentId),
		onSuccess: result => {
			const [first] = result.services
			if (result.warning && first) {
				setInstalled({ service: first, warning: result.warning })
				return
			}
			if (first) {
				onDone(first)
			}
		},
	})

	if (installed) {
		return (
			<div>
				<p className='mb-3 text-body'>
					The services were created, but the domain did not come up: {installed.warning}
				</p>
				<p className='mb-3 text-label text-muted-foreground'>
					Point the DNS record at this server, then retry the certificate from the Domains tab.
				</p>
				<DialogFooter>
					<Button variant='primary' onClick={() => onDone(installed.service)}>
						Done
					</Button>
				</DialogFooter>
			</div>
		)
	}

	return (
		<form
			onSubmit={event => {
				event.preventDefault()
				install.mutate()
			}}
		>
			<Field label='Application'>
				<TemplatePicker templates={templates.data ?? []} value={slug} onChange={setSlug} />
			</Field>

			<Field label='Domain' hint='These applications write their own URL into their configuration on first boot.'>
				<Input
					required
					value={hostname}
					onChange={event => setHostname(event.target.value)}
					placeholder='app.example.com'
					spellCheck={false}
				/>
			</Field>

			{selected ? (
				<p className='mb-3 text-label text-muted-foreground'>
					Creates {selected.services.map(service => service.name).join(', ')}. Deploy the project to start it.
				</p>
			) : null}

			<ErrorText error={install.error} />
			<DialogFooter>
				<Button variant='ghost' onClick={onCancel}>
					Cancel
				</Button>
				<Button type='submit' variant='primary' disabled={install.isPending || !selected}>
					<IconPlus />
					{install.isPending ? 'Installing…' : 'Install'}
				</Button>
			</DialogFooter>
		</form>
	)
}

/** The catalog as a list: one row per application, what it does under its name. */
function TemplatePicker({
	templates,
	value,
	onChange,
}: {
	templates: Template[]
	value: string
	onChange: (slug: string) => void
}) {
	return (
		<div className='max-h-64 overflow-y-auto rounded-lg border border-input'>
			{templates.map(template => (
				<button
					key={template.slug}
					type='button'
					aria-pressed={template.slug === value}
					onClick={() => onChange(template.slug)}
					className='flex w-full items-baseline gap-2.5 border-b border-input px-2.5 py-2 text-left text-body last:border-b-0 hover:bg-muted aria-pressed:bg-accent'
				>
					{template.name}
					<span className='min-w-0 truncate text-label text-muted-foreground'>{template.description}</span>
					<span className='ml-auto shrink-0 text-label text-muted-foreground'>{template.tags.join(' ')}</span>
				</button>
			))}
		</div>
	)
}
