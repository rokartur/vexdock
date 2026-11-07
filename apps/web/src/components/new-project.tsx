import { useState } from 'react'
import { IconPlus } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { TagInput } from '@/components/ui/tag-input'
import { api } from '../lib/api'
import { projectsQuery } from '../lib/queries'
import { Field, FormDialog, Input } from './primitives'

/**
 * A project is the folder its services live in. What it runs is decided one
 * service at a time inside it, so this form asks only for a name and its tags.
 */
export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()

	const [name, setName] = useState('')
	const [tags, setTags] = useState<string[]>([])

	const create = useMutation({
		mutationFn: () => api.createProject({ name, tags }),
		onSuccess: async project => {
			await queryClient.invalidateQueries({ queryKey: ['projects'] })
			onOpenChange(false)
			setName('')
			setTags([])
			// The dialog's exit is the motion; a page swap would freeze it in the snapshot.
			await navigate({ to: '/projects/$projectId', params: { projectId: project.id }, viewTransition: false })
		},
	})

	return (
		<FormDialog
			open={open}
			onOpenChange={next => {
				onOpenChange(next)
				if (next) return
				setName('')
				setTags([])
			}}
			title='New project'
			action='Create project'
			icon={IconPlus}
			mutation={create}
			onSubmit={() => create.mutate()}
		>
			<div className='grid gap-x-6 gap-y-3 md:grid-cols-2 [&>*]:mb-0'>
				<Field label='Name'>
					<Input required value={name} onChange={event => setName(event.target.value)} placeholder='my-app' />
				</Field>
				<ProjectTags label='Tags (optional)' value={tags} onChange={setTags} />
			</div>
		</FormDialog>
	)
}

/** Tags are slugs, so what is typed is lowercased and dashed; the suggestions are every tag already in use. */
export function ProjectTags({
	label,
	value,
	onChange,
}: {
	label: string
	value: string[]
	onChange: (tags: string[]) => void
}) {
	const projects = useQuery(projectsQuery)
	const knownTags = [...new Set((projects.data ?? []).flatMap(project => project.tags))]
	return (
		<TagInput
			label={label}
			placeholder='staging'
			value={value}
			onValueChange={next => onChange([...new Set(next.map(toTag).filter(Boolean))])}
			suggestions={knownTags}
		/>
	)
}

function toTag(raw: string) {
	return raw
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, '-')
		.replaceAll(/^-|-$/gu, '')
}
