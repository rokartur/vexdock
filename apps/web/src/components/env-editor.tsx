import { Fragment, useState } from 'react'
import { IconFileText, IconPlus, IconTable, IconTrash, type Icon as TablerIcon } from '@tabler/icons-react'
import { type FetchQueryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import type { EnvVar } from '../lib/api'
import { fromDotenv, lineProblems, saveProblems, toDotenv, unsaved } from '../lib/dotenv'
import {
	ErrorText,
	FormSection,
	FormSkeleton,
	IconButton,
	Input,
	RelativeTime,
	SaveButton,
	Segmented,
} from './primitives'

const LINE = /^(?<indent>\s*)(?<key>[^\s=#]+)=(?<value>.*)$/u

const MODES = [
	{ value: 'table', label: 'Table', icon: IconTable },
	{ value: 'text', label: 'Text', icon: IconFileText },
] as const

/**
 * The .env text stays the one source of truth: the table parses it and writes it back, so a key
 * edited in one mode is already there in the other and Save keeps sending the same lines. The API
 * stores keys and values only, so a table edit writes the text without the comments Save would drop.
 */
function VariablesEditor({
	title,
	value,
	onChange,
	stored,
	shared,
	rows = 12,
	saveError,
}: {
	/** The card's title, which names its controls apart from a second card on the same page. */
	title: string
	value: string
	onChange: (value: string) => void
	/** What the server returned: carries the secret flag a round trip must keep, and the age of each key. */
	stored: EnvVar[]
	/** The layer above, for the keys this one overrides. Left out where there is no layer above. */
	shared?: EnvVar[]
	rows?: number
	saveError: Error | null
}) {
	const [mode, setMode] = useState<'table' | 'text'>('table')
	const vars = fromDotenv(value, stored)
	const [problem] = lineProblems(value)
	const overriding = shared ? vars.filter(v => shared.some(above => above.key === v.key)).length : 0
	// The table's warning below already names this line, so a Save refused for it turns that warning into the error.
	const refusedHere = mode === 'table' && problem !== undefined && saveError?.message === problem

	return (
		<div className='grid gap-3'>
			<ErrorText error={refusedHere ? null : saveError} className='mb-0' />
			<div className='flex items-center justify-between gap-3'>
				<span className='text-xs text-muted'>
					{problem === undefined
						? `${vars.length.toLocaleString('en-US')} ${vars.length === 1 ? 'key' : 'keys'}`
						: 'Not counted until the text parses'}
					{problem === undefined && overriding > 0
						? `, ${overriding.toLocaleString('en-US')} overriding the project`
						: null}
					{mode === 'text' ? ', comments are not saved' : null}
				</span>
				<Segmented label={`${title} view`} value={mode} options={MODES} onChange={setMode} />
			</div>
			{mode === 'text' ? (
				<EnvEditor label={`${title} as text`} rows={rows} value={value} onChange={onChange} />
			) : problem === undefined ? (
				<VariableRows
					title={title}
					vars={vars}
					stored={stored}
					shared={shared}
					onChange={next => onChange(toDotenv(next))}
				/>
			) : (
				// The table writes the text back from the keys it parsed, so an edit here would delete this line.
				// Remounted on a refused Save, so the danger Alert's role='alert' announces it.
				<Alert key={String(refusedHere)} tone={refusedHere ? 'danger' : 'warning'} title={problem}>
					Fix it in Text view, then the table opens again.
				</Alert>
			)}
		</div>
	)
}

const ROW = 'grid items-center gap-2 px-2 py-1.5'

/** The table drops what no key may hold; a leading digit or an empty key is left for Save to name. */
const keyText = (typed: string) => typed.replaceAll(/[^A-Za-z0-9_]/gu, '')

function VariableRows({
	title,
	vars,
	stored,
	shared,
	onChange,
}: {
	title: string
	vars: EnvVar[]
	stored: EnvVar[]
	shared?: EnvVar[]
	onChange: (vars: EnvVar[]) => void
}) {
	const [key, setKey] = useState('')
	// Bumped on every removal, so the rows remount and none inherits the revealed value of the row it replaced.
	const [removals, setRemovals] = useState(0)
	const columns = cn(
		'grid-cols-[minmax(0,1fr)_2.25rem]',
		shared
			? 'sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_6rem_2.25rem]'
			: 'sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_2.25rem]',
	)

	const add = () => {
		if (key === '') return
		onChange([...vars, { key, value: '', is_secret: true, updated_at: '' }])
		setKey('')
	}
	const remove = (index: number) => {
		setRemovals(removals + 1)
		onChange(vars.filter((_, i) => i !== index))
	}
	const patch = (index: number, next: Partial<EnvVar>) =>
		onChange(vars.map((variable, i) => (i === index ? { ...variable, ...next } : variable)))

	return (
		// Inside a FormSection body (p-5): inner corner = surface - padding, never under 6px.
		<div className='rounded-[max(6px,calc(var(--radius-surface)-20px))] border'>
			<div className={cn(ROW, columns, 'border-b border-border-subtle text-xs text-muted max-sm:hidden')}>
				<span>Key</span>
				<span>Value</span>
				{shared ? <span>Overrides</span> : null}
				<span />
			</div>
			{vars.map((variable, index) => (
				// Keyed by position: a key renamed one character at a time would remount the input and lose the caret.
				<div
					key={`${removals}:${index}`}
					className={cn(ROW, columns, 'items-start border-b border-border-subtle')}
				>
					<span className='grid gap-0.5'>
						<Input
							mono
							aria-label={`${title}: key ${index + 1}`}
							value={variable.key}
							onChange={event => patch(index, { key: keyText(event.target.value) })}
						/>
						<span className='px-1 text-xs text-muted'>
							<UpdatedAt at={stored.find(saved => saved.key === variable.key)?.updated_at} />
						</span>
					</span>
					<span className='max-sm:col-span-full max-sm:row-start-2'>
						{/* An input drops line breaks, so a pasted PEM key would save flattened. */}
						{variable.value.includes('\n') ? (
							<span className='flex h-control-md items-center px-1 text-xs text-muted'>
								Multi-line value, edit it in Text view
							</span>
						) : (
							<Input
								mono
								type='password'
								autoComplete='new-password'
								aria-label={`${title}: value of ${variable.key || `key ${index + 1}`}`}
								value={variable.value}
								onChange={event => patch(index, { value: event.target.value })}
							/>
						)}
					</span>
					{shared ? (
						<span className='flex h-control-md items-center max-sm:col-span-full max-sm:row-start-3 max-sm:empty:hidden'>
							{shared.some(above => above.key === variable.key) ? <Badge>Overrides</Badge> : null}
						</span>
					) : null}
					<span className='flex h-control-md items-center max-sm:col-start-2 max-sm:row-start-1'>
						<IconButton
							icon={IconTrash}
							label={`Remove ${variable.key || `key ${index + 1}`} from ${title}`}
							onClick={() => remove(index)}
						/>
					</span>
				</div>
			))}
			<div className={cn(ROW, columns)}>
				<Input
					mono
					aria-label={`${title}: new key`}
					placeholder='KEY'
					value={key}
					onChange={event => setKey(keyText(event.target.value))}
					onKeyDown={event => {
						if (event.key !== 'Enter') return
						// Enter would otherwise submit the card and save without the new key.
						event.preventDefault()
						add()
					}}
				/>
				<span className={cn('text-xs text-muted max-sm:hidden', shared && 'sm:col-span-2')}>
					Enter adds the row
				</span>
				<span className='flex h-control-md items-center'>
					<IconButton icon={IconPlus} label={`Add the key to ${title}`} disabled={key === ''} onClick={add} />
				</span>
			</div>
		</div>
	)
}

type VariablesCardProps = {
	title: string
	icon: TablerIcon
	query: FetchQueryOptions<EnvVar[], Error, EnvVar[], string[]>
	save: (variables: EnvVar[]) => Promise<unknown>
	shared?: EnvVar[]
	rows?: number
}

/** One layer of variables as a card. The editor mounts only once the read lands: an editor over a failed read would
 * look empty, and its Save would send an empty list over every stored variable. */
export function VariablesCard(props: VariablesCardProps) {
	const variables = useQuery(props.query)
	if (!variables.data) {
		return variables.error ? (
			// In its card, so a page with two of them says which one failed.
			<FormSection title={props.title} icon={props.icon}>
				<ErrorText error={variables.error} />
			</FormSection>
		) : (
			<FormSkeleton label='Loading variables' cards={1} />
		)
	}
	// A failed re-read after a save keeps the data, so its error reaches the form instead of the skeleton branch.
	return <VariablesForm {...props} stored={variables.data} readError={variables.error} />
}

function VariablesForm({
	title,
	icon,
	query,
	save,
	shared,
	rows,
	stored,
	readError,
}: VariablesCardProps & { stored: EnvVar[]; readError: Error | null }) {
	const queryClient = useQueryClient()
	const [text, setText] = useState(() => toDotenv(stored))
	// Set when a save landed but its re-read failed: the next read that lands restarts the draft, unless it was edited since.
	const [staleRead, setStaleRead] = useState<{ stored: EnvVar[]; text: string } | null>(null)
	if (staleRead && stored !== staleRead.stored) {
		setStaleRead(null)
		if (text === staleRead.text) setText(toDotenv(stored))
	}

	const write = useMutation({
		// What was read goes along, so an untouched secret keeps its stored value instead of its own mask.
		mutationFn: (sent: string) => {
			const [problem] = saveProblems(sent)
			if (problem !== undefined) throw new Error(problem)
			return save(fromDotenv(sent, stored))
		},
		// A secret typed in plain comes back masked, so the draft restarts from a fresh read, not from the typing,
		// unless the reader typed on while it saved. A failed re-read lands on the query, so the save still reads as saved.
		onSuccess: async (_, sent) => {
			const fresh = await queryClient.fetchQuery({ ...query, staleTime: 0 }).catch(() => null)
			if (fresh) setText(current => (current === sent ? toDotenv(fresh) : current))
			else setStaleRead({ stored, text: sent })
		},
	})

	return (
		<FormSection
			title={title}
			icon={icon}
			hint='Redeploy to apply.'
			onSave={() => write.mutate(text)}
			actions={<SaveButton mutation={write} dirty={lineProblems(text).length > 0 || unsaved(text, stored)} />}
		>
			<VariablesEditor
				title={title}
				saveError={write.error ?? readError}
				value={text}
				onChange={next => {
					setText(next)
					// A refused Save stays until the edit fixes what it named; any other error clears on the next edit.
					if (write.isError && !saveProblems(next).includes(write.error.message)) write.reset()
				}}
				stored={stored}
				shared={shared}
				rows={rows}
			/>
		</FormSection>
	)
}

function UpdatedAt({ at }: { at: string | undefined }) {
	if (!at) return 'Not saved yet'
	return (
		<>
			Updated <RelativeTime at={at} />
		</>
	)
}

/** A .env textarea with a gutter and highlighting: a transparent textarea stacked over a colored copy of its text. */
function EnvEditor({
	label,
	value,
	onChange,
	rows,
}: {
	label: string
	value: string
	onChange: (value: string) => void
	rows: number
}) {
	const lines = value.split('\n')
	// Height is rows of leading-5 line boxes plus py-2 top and bottom.
	return (
		<div
			className='overflow-auto rounded-control border border-border-strong bg-console font-mono text-base leading-5 transition-colors focus-within:border-foreground md:text-xs'
			style={{ height: rows * 20 + 16 }}
		>
			<div className='flex min-h-full w-fit min-w-full'>
				<div
					aria-hidden
					className='sticky left-0 z-10 shrink-0 border-r border-border-subtle bg-console py-2 pr-2 pl-3 text-right text-muted select-none'
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
						placeholder='KEY=value'
						aria-label={label}
						spellCheck={false}
						wrap='off'
						className='col-start-1 row-start-1 w-full resize-none overflow-hidden bg-transparent px-3 py-2 font-mono whitespace-pre text-transparent caret-foreground outline-none placeholder:text-muted'
					/>
				</div>
			</div>
		</div>
	)
}

function Line({ text }: { text: string }) {
	if (text.trimStart().startsWith('#')) return <span className='text-muted'>{text}</span>
	const groups = LINE.exec(text)?.groups
	if (!groups) return <span>{text}</span>
	return (
		<>
			{groups.indent}
			<span className='text-syntax-type'>{groups.key}</span>
			<span className='text-muted'>=</span>
			<span className='text-syntax-string'>{groups.value}</span>
		</>
	)
}
