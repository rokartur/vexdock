import type { Access, Level } from '../lib/access'
import { Check, Select } from './primitives'

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
	projects: { id: string; name: string }[]
	value: Access
	onChange: (next: Access) => void
}) {
	const setLevel = (id: string, level: Level | undefined) => {
		const others = Object.entries(value.grants).filter(([projectId]) => projectId !== id)
		onChange({ ...value, grants: Object.fromEntries(level ? [...others, [id, level]] : others) })
	}

	return (
		<div className='rounded-lg divide-y divide-border border border-border'>
			<div className='px-3 py-2'>
				<Check
					label='Full access: every project and the whole server'
					checked={value.full}
					onChange={full => onChange({ ...value, full })}
				/>
			</div>
			{projects.map(project => {
				const level = value.grants[project.id]
				return (
					<div key={project.id} className='flex min-h-11 items-center justify-between gap-3 px-3 py-1.5'>
						<Check
							label={project.name}
							checked={level !== undefined}
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
							<span className='text-xs text-muted'>{value.full ? '' : 'no access'}</span>
						)}
					</div>
				)
			})}
		</div>
	)
}
