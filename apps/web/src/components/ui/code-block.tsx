import {
	type CSSProperties,
	Fragment,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import { IconChevronDown, IconFileCode } from '@tabler/icons-react'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'
import { CopyButton } from './copy-button'

type CodeBlockProps = {
	code: string
	filename?: string
	language?: string
	maxLines?: number
}

type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'function' | 'property' | 'tag' | 'punctuation'

const tokenClasses = {
	comment: 'text-muted italic',
	string: 'text-syntax-string',
	number: 'text-syntax-number',
	keyword: 'text-syntax-keyword',
	type: 'text-syntax-type',
	function: 'text-syntax-function',
	property: 'text-syntax-property',
	tag: 'text-syntax-type',
	punctuation: 'text-secondary',
} satisfies Record<TokenKind, string>

const keywordPattern =
	/^(?:abstract|as|async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|private|protected|public|readonly|return|set|static|switch|throw|try|type|typeof|var|void|while|with|yield|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE)$/
const literalPattern = /^(?:true|false|null|undefined|NaN|Infinity)$/
const typePattern =
	/^(?:Array|Boolean|Date|Error|Map|Number|Promise|Record|Set|String|ReactNode|HTMLElement|HTMLButtonElement|Event|unknown|never|void|any|boolean|number|string|object)$/
const tokenPattern =
	/\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$-]*\b|[{}[\]();,.<>:=+*/!?|&-]/g

const plainLanguages = new Set(['bash', 'sh', 'log', 'text'])

const textEnter = { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }
const textExit = { duration: motionTokens.duration.instant, ease: motionTokens.ease.standard }

export function CodeBlock({ code, filename, language = 'tsx', maxLines }: CodeBlockProps) {
	const displayLanguage = language.toLowerCase().replace(/^\./, '')
	const reduced = useReducedMotion() ?? false
	const preId = useId()
	const lineCount = code.split('\n').length
	const collapsible = maxLines != null && maxLines > 0 && lineCount > maxLines
	const [expanded, setExpanded] = useState(false)
	const open = !collapsible || expanded
	const preRef = useRef<HTMLPreElement>(null)
	const measured = useRef<{ full: number; collapsed: number } | null>(null)
	// Before the first measurement the clip height comes from CSS, so the server render is already collapsed.
	const height = useMotionValue<number | string>(open ? 'auto' : 'var(--code-collapsed)')
	const target = useRef({ open, reduced })
	const settleRef = useRef<(instant: boolean) => void>(() => {})

	// The source area follows its content on a spring: expanding, collapsing and new code all resize smoothly.
	useLayoutEffect(() => {
		const pre = preRef.current
		if (!pre) return
		const settle = (instant: boolean) => {
			const sizes = measured.current
			if (!sizes) return
			const next = target.current.open ? sizes.full : sizes.collapsed
			if (instant || target.current.reduced || typeof height.get() !== 'number') height.jump(next)
			else animate(height, next, motionTokens.spring.smooth)
		}
		const observer = new ResizeObserver(() => {
			const style = getComputedStyle(pre)
			const full = pre.offsetHeight
			const collapsed = maxLines
				? Math.min(
						full,
						Math.round(
							maxLines * Number.parseFloat(style.lineHeight) +
								Number.parseFloat(style.paddingTop) +
								Number.parseFloat(style.paddingBottom),
						),
					)
				: full
			const first = !measured.current
			measured.current = { full, collapsed }
			settle(first)
		})
		observer.observe(pre)
		settleRef.current = settle
		return () => observer.disconnect()
	}, [height, maxLines])
	useLayoutEffect(() => {
		target.current = { open, reduced }
		settleRef.current(false)
	}, [open, reduced])
	const codeLines: (CSSProperties & Record<'--code-lines', number>) | undefined = maxLines
		? { '--code-lines': maxLines }
		: undefined
	const expandLabels = [`Show all ${lineCount} lines`, 'Show fewer lines'] as const
	const expandLabel = expandLabels[expanded ? 1 : 0]

	return (
		<section
			aria-label={filename ? `${filename} source code` : `${displayLanguage} source code`}
			style={codeLines}
			className='w-full max-w-full min-w-0 overflow-hidden rounded-panel border bg-surface'
		>
			<header className='flex min-h-[52px] items-center justify-between gap-2.5 border-b border-border-subtle bg-surface-raised py-1.5 pr-2.5 pl-3 max-[420px]:pl-2.5'>
				<div className='flex min-w-0 items-baseline gap-1.5 text-sm font-medium text-secondary'>
					<IconFileCode
						size={16}
						stroke={1.75}
						aria-hidden='true'
						className='shrink-0 self-center text-muted'
					/>
					<FileName name={filename ?? 'Source code'} reduced={reduced} />
					<span className="shrink-0 font-mono text-xs font-normal text-muted before:mr-1.5 before:text-border-strong before:content-['·']">
						{displayLanguage}
					</span>
				</div>
				<CopyButton
					value={code}
					label='Copy code'
					className='max-[420px]:w-control-sm max-[420px]:px-0 max-[420px]:[&>span:last-of-type]:hidden'
				/>
			</header>
			<motion.div
				style={{ height }}
				className='overflow-hidden [--code-collapsed:calc(var(--code-lines,0)*var(--text-sm)*1.7+var(--spacing)*8)] max-[420px]:[--code-collapsed:calc(var(--code-lines,0)*var(--text-xs)*1.7+var(--spacing)*6)]'
			>
				<pre
					ref={preRef}
					id={preId}
					// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a region that scrolls sideways needs focus to scroll by keyboard
					tabIndex={0}
					aria-label='Selectable source code'
					className='relative m-0 overflow-auto p-4 font-mono text-sm leading-[1.7] whitespace-pre [tab-size:2] text-foreground [font-variant-ligatures:none] max-[420px]:p-3 max-[420px]:text-xs'
				>
					<AnimatePresence initial={false} mode='popLayout'>
						<motion.code
							key={code}
							initial={reduced ? false : { opacity: 0, y: 4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={
								reduced
									? { opacity: 0, transition: { duration: 0 } }
									: { opacity: 0, transition: textExit }
							}
							transition={reduced ? { duration: 0 } : textEnter}
							className='block'
						>
							{/* vexdock: the tokenizer reads `https://` in a shell line as a comment, so shell and log stay plain. */}
							{plainLanguages.has(displayLanguage) ? code : highlight(code, displayLanguage)}
						</motion.code>
					</AnimatePresence>
				</pre>
			</motion.div>
			{collapsible && (
				<button
					type='button'
					aria-expanded={expanded}
					aria-controls={preId}
					onClick={() => setExpanded(value => !value)}
					className='group/expand flex min-h-[44px] w-full items-center justify-center gap-1.5 border-0 border-t border-border-subtle bg-surface-raised px-3 text-sm font-medium text-secondary transition-[color,background-color] hover:bg-surface-muted hover:text-foreground'
				>
					{/* Both labels reserve the cell, so the chevron never moves when the words change. */}
					<span aria-hidden='true' className='inline-grid min-w-0 whitespace-nowrap'>
						{expandLabels.map(text => (
							<span key={text} className='invisible col-start-1 row-start-1 min-w-0'>
								{text}
							</span>
						))}
						<span className='col-start-1 row-start-1 grid min-w-0'>
							<SwapText value={expandLabel} reduced={reduced} />
						</span>
					</span>
					<span className='sr-only'>{expandLabel}</span>
					<motion.span
						aria-hidden='true'
						initial={false}
						animate={{ rotate: expanded ? 180 : 0 }}
						transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}
						className='grid shrink-0 place-items-center text-muted group-hover/expand:text-foreground'
					>
						<IconChevronDown size={16} stroke={1.75} />
					</motion.span>
				</button>
			)}
		</section>
	)
}

// A new file name swaps in while its box follows the new width on a spring, then returns to auto so it can still truncate.
function FileName({ name, reduced }: { name: string; reduced: boolean }) {
	const sizer = useRef<HTMLSpanElement>(null)
	const rest = useRef(0)
	const width = useMotionValue<number | 'auto'>('auto')
	useEffect(() => {
		const node = sizer.current
		if (!node) return
		const observer = new ResizeObserver(() => {
			rest.current = node.offsetWidth
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	useLayoutEffect(() => {
		const moving = width.get()
		const to = sizer.current?.offsetWidth ?? 0
		const from = typeof moving === 'number' ? moving : rest.current
		rest.current = to
		if (reduced || !from || !to || Math.abs(from - to) < 1) {
			width.jump('auto')
			return
		}
		width.jump(from)
		const controls = animate(width, to, {
			...motionTokens.spring.morph,
			onComplete: () => width.jump('auto'),
		})
		return () => controls.stop()
	}, [name, reduced, width])
	return (
		<motion.span
			style={{ width }}
			className='relative inline-grid min-w-0 overflow-hidden whitespace-nowrap text-foreground'
		>
			<span
				ref={sizer}
				aria-hidden='true'
				className='pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap'
			>
				{name}
			</span>
			<span aria-hidden='true' className='col-start-1 row-start-1 grid min-w-0'>
				<SwapText value={name} reduced={reduced} />
			</span>
			<span className='sr-only'>{name}</span>
		</motion.span>
	)
}

// Text that changes in place: the new words rise in with a soft blur while the old ones leave upward, faster.
function SwapText({ value, reduced }: { value: string; reduced: boolean }) {
	return (
		<AnimatePresence initial={false}>
			<motion.span
				key={value}
				initial={reduced ? false : { opacity: 0, y: '0.3em', filter: `blur(${motionTokens.blur.soft}px)` }}
				animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
				exit={
					reduced
						? { opacity: 0, transition: { duration: 0 } }
						: {
								opacity: 0,
								y: '-0.3em',
								filter: `blur(${motionTokens.blur.subtle}px)`,
								transition: textExit,
							}
				}
				transition={reduced ? { duration: 0 } : textEnter}
				className='col-start-1 row-start-1 block min-w-0 overflow-hidden text-ellipsis'
			>
				{value}
			</motion.span>
		</AnimatePresence>
	)
}

function highlight(code: string, language: string): ReactNode[] {
	const parts: ReactNode[] = []
	let cursor = 0
	for (const match of code.matchAll(tokenPattern)) {
		const value = match[0]
		const index = match.index
		if (cursor < index) parts.push(code.slice(cursor, index))
		const kind = tokenKind(value, code, index, language)
		parts.push(
			kind ? (
				<span key={`${index}-${value}`} className={tokenClasses[kind]}>
					{value}
				</span>
			) : (
				<Fragment key={`${index}-${value}`}>{value}</Fragment>
			),
		)
		cursor = index + value.length
	}
	if (cursor < code.length) parts.push(code.slice(cursor))
	return parts
}

function tokenKind(value: string, source: string, index: number, language: string): TokenKind | undefined {
	if (value.startsWith('//') || value.startsWith('/*') || value.startsWith('<!--')) return 'comment'
	if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) {
		return language === 'json' && /^\s*:/.test(source.slice(index + value.length)) ? 'property' : 'string'
	}
	if (/^\d/.test(value)) return 'number'
	if (keywordPattern.test(value) || literalPattern.test(value)) return 'keyword'
	if (typePattern.test(value)) return 'type'
	if (/^[{}[\]();,.<>:=+*/!?|&-]$/.test(value)) return 'punctuation'

	const before = source.slice(0, index)
	const after = source.slice(index + value.length)
	const markup = language === 'tsx' || language === 'jsx' || language === 'html' || language === 'vue'
	if (markup && /<\/?$/.test(before)) return 'tag'
	if (/^\s*\(/.test(after) && language !== 'json') return 'function'
	if ((language === 'css' || language === 'tsx' || language === 'jsx') && /^\s*[:=]/.test(after)) return 'property'
	return undefined
}
