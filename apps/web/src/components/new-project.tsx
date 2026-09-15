import { useState } from 'react'
import { IconPlus, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '../lib/api'
import { Button, ErrorText, Field, Input } from './primitives'

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className='sm:max-w-lg'>
				<DialogHeader>
					<DialogTitle>New project</DialogTitle>
				</DialogHeader>
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

				<Field label='Tags (optional)' hint='Enter adds one, click a tag to drop it.'>
					<TagInput value={tags} onChange={setTags} suggestions={knownTags} />
				</Field>
			</div>

			<ErrorText error={create.error} />
			<DialogFooter>
				<Button variant='ghost' onClick={onDone}>
					Cancel
				</Button>
				<Button type='submit' variant='primary' disabled={create.isPending}>
					<IconPlus />
					{create.isPending ? 'Creating…' : 'Create'}
				</Button>
			</DialogFooter>
		</form>
	)
}

/**
 * Tags are plain labels: typing one and pressing Enter creates it, and tags
 * already used by other projects are offered as native autocomplete.
 */
function TagInput({
	value,
	onChange,
	suggestions,
}: {
	value: string[]
	onChange: (tags: string[]) => void
	suggestions: string[]
}) {
	const [draft, setDraft] = useState('')

	const add = (raw: string) => {
		const tag = raw
			.trim()
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/gu, '-')
			.replaceAll(/^-|-$/gu, '')
		if (tag && !value.includes(tag)) onChange([...value, tag])
		setDraft('')
	}

	return (
		<>
			<Input
				list='known-project-tags'
				value={draft}
				placeholder='staging'
				onChange={event => setDraft(event.target.value)}
				// A blur commits the draft so a typed tag is never lost on submit.
				onBlur={() => add(draft)}
				onKeyDown={event => {
					if (event.key === 'Enter' || event.key === ',') {
						event.preventDefault()
						add(draft)
					}
					if (event.key === 'Backspace' && draft === '') onChange(value.slice(0, -1))
				}}
			/>
			<datalist id='known-project-tags'>
				{suggestions.map(tag => (
					<option key={tag} value={tag}>
						{tag}
					</option>
				))}
			</datalist>
			{value.length > 0 ? (
				<div className='mt-2 flex flex-wrap gap-1.5'>
					{value.map(tag => (
						<Badge
							key={tag}
							variant='outline'
							render={
								<button
									type='button'
									aria-label={`Remove ${tag}`}
									onClick={() => onChange(value.filter(other => other !== tag))}
								/>
							}
							className='cursor-pointer hover:bg-accent'
						>
							{tag}
							<IconX />
						</Badge>
					))}
				</div>
			) : null}
		</>
	)
}
