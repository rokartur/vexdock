import { Fragment } from 'react'

const LINE = /^(?<indent>\s*)(?<key>[^\s=#]+)=(?<value>.*)$/u

/** A .env textarea with a gutter and highlighting: a transparent textarea stacked over a coloured copy of its text. */
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
