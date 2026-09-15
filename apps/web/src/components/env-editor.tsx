import { Fragment, useState } from 'react'
import { IconFileText, IconTable, IconTrash } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import type { EnvVar } from '../lib/api'
import { fromDotenv, toDotenv } from '../lib/dotenv'
import { cn } from '../utils/cn'
import { IconButton, Input, RelativeTime, Segmented } from './primitives'

const LINE = /^(?<indent>\s*)(?<key>[^\s=#]+)=(?<value>.*)$/u

const MODES = [
	{ value: 'table', label: 'Table', icon: IconTable },
	{ value: 'text', label: 'Text', icon: IconFileText },
] as const

/**
 * The .env text stays the one source of truth: the table parses it and writes it back, so a key
 * edited in one mode is already there in the other and Save keeps sending the same lines.
 */
export function VariablesEditor({
	value,
	onChange,
	stored,
	shared,
	rows = 12,
}: {
	value: string
	onChange: (value: string) => void
	/** What the server returned: carries the secret flag a round trip must keep, and the age of each key. */
	stored: EnvVar[]
	/** The layer above, for the keys this one overrides. Left out where there is no layer above. */
	shared?: EnvVar[]
	rows?: number
}) {
	const [mode, setMode] = useState<'table' | 'text'>('table')
	const vars = fromDotenv(value, stored)
	const overriding = shared ? vars.filter(v => shared.some(above => above.key === v.key)).length : 0

	return (
		<div className='grid gap-3'>
			<div className='flex items-center justify-between gap-3'>
				<span className='text-label text-muted-foreground'>
					{vars.length} {vars.length === 1 ? 'key' : 'keys'}
					{overriding > 0 ? `, ${overriding} overriding the project` : null}
				</span>
				<Segmented value={mode} options={MODES} onChange={setMode} />
			</div>
			{mode === 'text' ? (
				<EnvEditor rows={rows} value={value} onChange={onChange} />
			) : (
				<VariableRows vars={vars} stored={stored} shared={shared} onChange={next => onChange(toDotenv(next))} />
			)}
		</div>
	)
}

const ROW = 'grid items-center gap-2 px-2 py-1.5'

function VariableRows({
	vars,
	stored,
	shared,
	onChange,
}: {
	vars: EnvVar[]
	stored: EnvVar[]
	shared?: EnvVar[]
	onChange: (vars: EnvVar[]) => void
}) {
	const [key, setKey] = useState('')
	const columns = shared
		? 'minmax(0,13rem) minmax(0,1fr) 9rem 4.5rem 2rem'
		: 'minmax(0,13rem) minmax(0,1fr) 4.5rem 2rem'

	const add = () => {
		const trimmed = key.trim()
		if (trimmed === '') return
		onChange([...vars, { key: trimmed, value: '', is_secret: true, updated_at: '' }])
		setKey('')
	}
	const patch = (index: number, next: Partial<EnvVar>) =>
		onChange(vars.map((variable, i) => (i === index ? { ...variable, ...next } : variable)))

	return (
		<div className='rounded-lg border bg-background'>
			<div
				style={{ gridTemplateColumns: columns }}
				className={cn(ROW, 'border-b border-rule text-label text-muted-foreground')}
			>
				<span>Key</span>
				<span>Value</span>
				{shared ? <span>From</span> : null}
				<span>Changed</span>
				<span />
			</div>
			{vars.map((variable, index) => (
				// Keyed by position: a key renamed one character at a time would remount the input and lose the caret.
				<div key={index} style={{ gridTemplateColumns: columns }} className={cn(ROW, 'border-b border-rule')}>
					<Input
						mono
						aria-label='Key'
						value={variable.key}
						onChange={event => patch(index, { key: event.target.value })}
					/>
					<Input
						mono
						aria-label={`Value of ${variable.key}`}
						value={variable.value}
						onChange={event => patch(index, { value: event.target.value })}
					/>
					{shared ? (
						<span>
							{shared.some(above => above.key === variable.key) ? (
								<Badge variant='outline'>overrides</Badge>
							) : null}
						</span>
					) : null}
					<span className='text-label'>
						<RelativeTime at={stored.find(saved => saved.key === variable.key)?.updated_at} />
					</span>
					<IconButton
						icon={IconTrash}
						label={`Remove ${variable.key}`}
						onClick={() => onChange(vars.filter((_, i) => i !== index))}
					/>
				</div>
			))}
			<div style={{ gridTemplateColumns: columns }} className={ROW}>
				<Input
					mono
					aria-label='New key'
					placeholder='KEY'
					value={key}
					onChange={event => setKey(event.target.value)}
					onKeyDown={event => {
						if (event.key !== 'Enter') return
						// Enter would otherwise submit the card and save without the new key.
						event.preventDefault()
						add()
					}}
				/>
				<span className='text-label text-muted-foreground'>Enter adds the row</span>
			</div>
		</div>
	)
}

/** A .env textarea with a gutter and highlighting: a transparent textarea stacked over a colored copy of its text. */
export function EnvEditor({
	value,
	onChange,
	rows = 12,
	placeholder = 'KEY=value',
}: {
	value: string
	onChange: (value: string) => void
	rows?: number
	placeholder?: string
}) {
	const lines = value.split('\n')
	// Height is rows of leading-5 line boxes plus py-2 top and bottom.
	return (
		<div
			className='overflow-auto rounded-lg border border-input bg-console font-mono text-label leading-5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50'
			style={{ height: rows * 20 + 16 }}
		>
			<div className='flex w-fit min-w-full'>
				<div
					aria-hidden
					className='sticky left-0 z-10 shrink-0 border-r border-rule bg-console py-2 pr-2 pl-3 text-right text-muted-foreground/50 select-none'
				>
					{lines.map((_, index) => (
						<div key={index}>{index + 1}</div>
					))}
				</div>
				<div className='grid flex-1'>
					<pre aria-hidden className='col-start-1 row-start-1 px-3 py-2 text-console-foreground'>
						{lines.map((line, index) => (
							<Fragment key={index}>
								{index > 0 ? '\n' : null}
								<Line text={line} />
							</Fragment>
						))}
					</pre>
					<textarea
						value={value}
						onChange={event => onChange(event.target.value)}
						placeholder={placeholder}
						spellCheck={false}
						wrap='off'
						className='col-start-1 row-start-1 w-full resize-none overflow-hidden bg-transparent px-3 py-2 font-mono whitespace-pre text-transparent caret-foreground outline-none placeholder:text-muted-foreground'
					/>
				</div>
			</div>
		</div>
	)
}

function Line({ text }: { text: string }) {
	if (text.trimStart().startsWith('#')) return <span className='text-muted-foreground'>{text}</span>
	const groups = LINE.exec(text)?.groups
	if (!groups) return <span>{text}</span>
	return (
		<>
			{groups.indent}
			<span className='text-code-key'>{groups.key}</span>
			<span className='text-muted-foreground'>=</span>
			<span className='text-code-value'>{groups.value}</span>
		</>
	)
}
