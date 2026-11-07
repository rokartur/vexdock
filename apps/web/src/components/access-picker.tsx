import type { UseQueryResult } from '@tanstack/react-query'
import type { Access, Level } from '../lib/access'
import type { Project } from '../lib/api'
import { Check, ErrorText, Select } from './primitives'
import { Skeleton } from './ui/skeleton'

const levels = [
	{ value: 'read', label: 'Read' },
	{ value: 'write', label: 'Write' },
] as const

/** Full access, or a level per checked project. Shared by the Create token dialog and the OAuth consent screen. */
export function AccessPicker({
	projects,
	value,
	onChange,
}: {
	projects: UseQueryResult<Project[]>
	value: Access
	onChange: (next: Access) => void
}) {
	const setLevel = (id: string, level: Level | undefined) => {
		const others = Object.entries(value.grants).filter(([projectId]) => projectId !== id)
		onChange({ ...value, grants: Object.fromEntries(level ? [...others, [id, level]] : others) })
	}

	return (
		<>
			<ErrorText error={projects.error} />
			{/* Inside a dialog body (p-4) or the auth card (p-6): inner corner = surface - padding, never under 6px. */}
			<div className='divide-y divide-border-subtle rounded-[max(6px,calc(var(--radius-surface)-16px))] border border-border'>
				<div className='px-3 py-2'>
					<Check
						label='Full access: every project and the whole server'
						checked={value.full}
						onChange={full => onChange({ ...value, full })}
					/>
				</div>
				{projects.isPending ? <Skeleton label='Loading projects' lines={3} className='px-3 py-3' /> : null}
				{projects.data?.length === 0 ? (
					<p className='px-3 py-2 text-xs text-muted'>No projects yet: only full access can be granted.</p>
				) : null}
				{projects.data?.map(project => {
					const level = value.grants[project.id]
					return (
						<div key={project.id} className='flex min-h-11 items-center justify-between gap-3 px-3 py-1.5'>
							<Check
								label={project.name}
								// Full access covers every project; the picks underneath come back when it is unticked.
								checked={value.full || level !== undefined}
								onChange={checked => setLevel(project.id, checked ? 'read' : undefined)}
								disabled={value.full}
								muted={value.full}
								className='min-w-0'
							/>
							{level && !value.full ? (
								<Select
									label={`Access to ${project.name}`}
									value={level}
									options={levels}
									onChange={next => setLevel(project.id, next)}
									className='w-28'
								/>
							) : (
								<span className='text-xs text-muted'>{value.full ? '' : 'No access'}</span>
							)}
						</div>
					)
				})}
			</div>
		</>
	)
}
