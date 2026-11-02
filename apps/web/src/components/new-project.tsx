import { useState } from 'react'
import { IconPlus } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { TagInput } from '@/components/ui/tag-input'
import { api } from '../lib/api'
import { Button, DialogFooter, ErrorText, Field, Input } from './primitives'

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title='New project' className='[--dialog-width:32rem]'>
				<NewProjectForm onDone={() => onOpenChange(false)} />
			</DialogContent>
		</Dialog>
	)
}

/**
 * A project is the folder its services live in. What it runs is decided one
 * service at a time inside it, so this form only needs a name.
 */
function NewProjectForm({ onDone }: { onDone: () => void }) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

	const [name, setName] = useState('')
	const [tags, setTags] = useState<string[]>([])

	const create = useMutation({
		mutationFn: () => api.createProject({ name, tags }),
		onSuccess: async project => {
			await queryClient.invalidateQueries({ queryKey: ['projects'] })
			onDone()
			await navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
		},
	})

	const knownTags = [...new Set((projects.data ?? []).flatMap(project => project.tags ?? []))]

	return (
		<form
			onSubmit={event => {
				event.preventDefault()
				create.mutate()
			}}
		>
			<div className='grid gap-x-6 md:grid-cols-2'>
				<Field label='Name'>
					<Input required value={name} onChange={event => setName(event.target.value)} placeholder='my-app' />
				</Field>

				<div className='mb-4'>
					<TagInput
						label='Tags (optional)'
						placeholder='staging'
						value={tags}
						onValueChange={next => setTags([...new Set(next.map(toTag).filter(Boolean))])}
						suggestions={knownTags}
					/>
				</div>
			</div>

			<ErrorText error={create.error} />
			<DialogFooter>
				<Button variant='ghost' onClick={onDone}>
					Cancel
				</Button>
				<Button type='submit' variant='primary' loading={create.isPending}>
					<IconPlus />
					Create
				</Button>
			</DialogFooter>
		</form>
	)
}

function toTag(raw: string) {
	return raw
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, '-')
		.replaceAll(/^-|-$/gu, '')
}
