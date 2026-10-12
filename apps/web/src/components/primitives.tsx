import {
	type ComponentProps,
	createContext,
	type ReactElement,
	type ReactNode,
	memo,
	useContext,
	useMemo,
	useEffect,
	useId,
	useState,
} from 'react'
import {
	IconAlertTriangle,
	IconArrowDown,
	IconCheck,
	IconCircleCheck,
	IconDeviceFloppy,
	IconInbox,
	IconInfoCircle,
	IconPlayerStop,
	IconRefresh,
	IconTrash,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { type useBlocker, useRouter, useRouterState } from '@tanstack/react-router'
import { cn } from 'cn'
import { motion } from 'motion/react'
import { createPortal } from 'react-dom'
import { Alert } from '@/components/ui/alert'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Breadcrumb } from '@/components/ui/breadcrumb'
import { Button as ArcButton, type ButtonVariant as ArcButtonVariant } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { EmptyState as ArcEmptyState } from '@/components/ui/empty-state'
import { Input as ArcInput } from '@/components/ui/input'
import { PasswordField } from '@/components/ui/password-field'
import { Progress } from '@/components/ui/progress'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select as ArcSelect } from '@/components/ui/select'
import { Switch as ArcSwitch } from '@/components/ui/switch'
import { Tabs as ArcTabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea as ArcTextarea } from '@/components/ui/textarea'
import { Tooltip } from '@/components/ui/tooltip'
import { labelOf, trailOf } from '@/lib/breadcrumb'
import { since, until } from '@/lib/format'

// The rules every primitive below follows: Arc UI's look (components/ui, tokens in styles.css), one primary
// action per view, sentence case everywhere, an icon on every action.

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

// Intent names, so pages never spell out Arc's "secondary".
const buttonVariants = {
	default: 'secondary',
	primary: 'primary',
	danger: 'danger',
	ghost: 'ghost',
} as const satisfies Record<ButtonVariant, ArcButtonVariant>

type ButtonProps = Omit<ComponentProps<typeof ArcButton>, 'variant' | 'size' | 'icon' | 'className'>

// Only the intent is ours; everything else passes through, so a Button can be a menu trigger (it takes the
// trigger's handlers and ref) or, with `render`, a router link.
export function Button({ variant = 'default', type = 'button', ...props }: ButtonProps & { variant?: ButtonVariant }) {
	return <ArcButton type={type} variant={buttonVariants[variant]} size='md' {...props} />
}

/** An icon-only action with its name in a tooltip. `sm` is the row size, `default` matches the buttons in a header. */
export function IconButton({
	icon: Icon,
	label,
	variant = 'ghost',
	size = 'sm',
	...props
}: Omit<ButtonProps, 'children'> & {
	icon: TablerIcon
	label: string
	variant?: ButtonVariant
	size?: 'sm' | 'default'
}) {
	return (
		<Tooltip content={label}>
			<ArcButton
				type='button'
				variant={buttonVariants[variant]}
				size={size === 'sm' ? 'sm' : 'md'}
				icon
				aria-label={label}
				{...props}
			>
				<Icon />
			</ArcButton>
		</Tooltip>
	)
}

/** navigator.platform is deprecated but still the one signal every browser ships. Unset during the prerender. */
export const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? '⌘' : 'Ctrl'

/**
 * A key combination shown next to the thing it triggers, one cap per key:
 * `<Keys keys={[mod, 'K']} />`. Arc has no key cap, so this is one drawn on its tokens.
 */
export function Keys({ keys }: { keys: string[] }) {
	return (
		<span className='inline-flex items-center gap-0.5'>
			{keys.map(key => (
				<kbd
					key={key}
					className='inline-flex h-5 min-w-5 items-center justify-center rounded-[calc(var(--radius-control)-4px)] border border-current/15 bg-current/8 px-1 font-sans text-xs text-current/65'
				>
					{key}
				</kbd>
			))}
		</span>
	)
}

const stateTones: Record<string, BadgeTone> = {
	running: 'success',
	healthy: 'success',
	success: 'success',
	issued: 'success',
	connected: 'success',
	open: 'success',
	'opens on deploy': 'warning',
	'closes on deploy': 'warning',
	starting: 'warning',
	queued: 'warning',
	restarting: 'warning',
	pending: 'warning',
	unhealthy: 'danger',
	failed: 'danger',
	dead: 'danger',
}

const toneText: Record<BadgeTone, string> = {
	neutral: 'text-muted',
	success: 'text-success',
	info: 'text-accent',
	warning: 'text-warning',
	danger: 'text-danger',
}

const toneIcons: Record<BadgeTone, TablerIcon> = {
	neutral: IconPlayerStop,
	success: IconCircleCheck,
	info: IconInfoCircle,
	warning: IconAlertTriangle,
	danger: IconAlertTriangle,
}

/** The color a state reads in, for the places that show the dot without the word. */
export function stateTone(value: string) {
	return toneText[stateTones[value] ?? 'neutral']
}

/** A state as an Arc badge: tone, icon and word together. `dot` drops the word for rows that are tight. */
export function Status({ value, dot }: { value: string; dot?: boolean }) {
	if (!value) return <span className='text-muted'>-</span>
	if (dot) {
		return (
			<span
				title={value}
				aria-label={value}
				className={cn('inline-block size-1.5 shrink-0 rounded-full bg-current', stateTone(value))}
			/>
		)
	}
	const tone = stateTones[value] ?? 'neutral'
	const Icon = toneIcons[tone]
	return (
		<Badge tone={tone} icon={<Icon />}>
			{value}
		</Badge>
	)
}

/** Re-fetches a section's data. Lives in the section header, next to its title. */
export function Refresh({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
	return <IconButton icon={IconRefresh} label='Refresh' onClick={onClick} disabled={busy} />
}

const ChromeContext = createContext<HTMLElement | null>(null)

/** True inside a `fill` Page, and inside the `fill` Section that takes what is left of it. Anything else resets it,
 * so only the last list of a page that asked for it stops capping its own height. */
const FillContext = createContext(false)

/** Whether this list should take its parent's height and scroll inside it. `DataTable` asks; a page never does. */
export function useFill() {
	return useContext(FillContext)
}

/** A dialog is portaled out of the page but not out of its context; its body is never the page's last list. */
function NoFill({ children }: { children: ReactNode }) {
	return <FillContext.Provider value={false}>{children}</FillContext.Provider>
}

/** Carries the shell's header element, which Page portals its breadcrumb and actions into. */
export function PageChrome({ value, children }: { value: HTMLElement | null; children: ReactNode }) {
	return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>
}

/**
 * The scrolling body of the shell. Every page is a Page, nothing else scrolls, and the header trail is read off the
 * URL. `labels` names segments the URL cannot, keyed by segment: a labeled segment is never wrapped in a link so the
 * label can carry its own interaction, and `null` drops the segment for path parts that only exist to nest routes.
 */
export function Page({
	labels,
	name,
	actions,
	toolbar,
	filters,
	fill = false,
	children,
}: {
	labels?: Record<string, ReactNode>
	/** What this page is about, for the tab, when the URL only has an id. */
	name?: string
	actions?: ReactNode
	/** Sub-navigation, on the left of the page's own first row. */
	toolbar?: ReactNode
	/** What narrows the page, on the right of that same row. */
	filters?: ReactNode
	/** The page is exactly as tall as the window and a `fill` Section takes what is left, so that section scrolls
	 * instead of the page. A window too short for its floor scrolls the page after all. */
	fill?: boolean
	children: ReactNode
}) {
	const router = useRouter()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const header = useContext(ChromeContext)
	const trail = trailOf(pathname, Object.keys(router.routesByPath)).filter(
		({ segment }) => labels?.[segment] !== null,
	)

	// The tab is named after the deepest thing the URL says, then what the page
	// is inside of: Logs · storefront-web · Vexdock. A segment standing in for an
	// id says nothing, so `name` speaks for it.
	const tail = trail.at(-1)
	const leaf = tail && labels?.[tail.segment] === undefined ? labelOf(tail.segment) : undefined
	const title = [leaf, name, 'Vexdock'].filter(Boolean).join(' · ')
	useEffect(() => {
		document.title = title
	}, [title])

	const head = (
		<>
			{/* A labeled segment renders its own picker, never wrapped in a link that would navigate on the click
			    that opens it. Only a plain segment links. */}
			<Breadcrumb
				className='min-w-0 flex-1'
				items={trail.map(({ segment, to, linkable }) => ({
					label: labelOf(segment),
					href: linkable && labels?.[segment] === undefined ? to : undefined,
					node: labels?.[segment],
				}))}
			/>
			{/* Buttons carry their own shrink-0, so this only squeezes text actions. */}
			{actions ? <div className='flex min-w-0 items-center gap-2'>{actions}</div> : null}
		</>
	)

	// Null only on the shell's very first render, before its bar has been
	// committed; it sets it during that commit, so nothing paints without it.
	return (
		<>
			{header ? createPortal(head, header) : null}
			{toolbar || filters ? (
				<div className='flex h-12 shrink-0 items-center gap-4 border-b px-6'>
					{toolbar}
					{filters ? <div className='ml-auto flex items-center gap-2'>{filters}</div> : null}
				</div>
			) : null}
			<div className={cn('min-h-0 flex-1 enter-children overflow-y-auto p-6', fill && 'flex flex-col')}>
				<FillContext.Provider value={fill}>{children}</FillContext.Provider>
			</div>
		</>
	)
}

/**
 * Sub-navigation for a Page's `toolbar`. A tab links to `base + suffix`; the
 * empty suffix is the layout's index route and only matches the base itself.
 */
export function Tabs({ base, tabs }: { base: string; tabs: { suffix: string; label: string; count?: number }[] }) {
	const pathname = useRouterState({ select: state => state.location.pathname })
	const active = tabs.find(tab =>
		tab.suffix === '' ? pathname === base || pathname === `${base}/` : pathname.startsWith(base + tab.suffix),
	)

	return (
		<ArcTabs value={active?.label ?? ''}>
			<TabsList>
				{tabs.map(tab => (
					<TabsTrigger key={tab.label} value={tab.label} href={base + tab.suffix}>
						{tab.label}
						{tab.count ? <span className='ml-1.5 font-mono text-xs text-muted'>{tab.count}</span> : null}
					</TabsTrigger>
				))}
			</TabsList>
		</ArcTabs>
	)
}

/** A joined row of options switching a value instead of the URL. An option may carry an icon, so a row of sources
 * reads as brands. */
export function Segmented<TValue extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: TValue
	/** `accessory` sits after the label: a run's duration, a count. */
	options: readonly { value: NoInfer<TValue>; label: string; icon?: TablerIcon; accessory?: ReactNode }[]
	onChange: (value: TValue) => void
	/** Names the group for assistive tech. */
	label?: string
}) {
	return (
		<SegmentedControl
			label={label}
			value={value}
			options={options.map(option => ({
				value: option.value,
				label: option.label,
				icon: option.icon ? <option.icon /> : undefined,
				accessory: option.accessory,
			}))}
			onValueChange={next => {
				const picked = options.find(option => option.value === next)
				if (picked) onChange(picked.value)
			}}
		/>
	)
}

// The sidebar's Collapsible.Panel height curve (ease-enter, 240ms): a pill whose row rides that panel lands without overshoot.
const slide = { duration: 0.24, ease: [0.16, 1, 0.3, 1] } as const

/** The selected item's background; it slides from the one selected before within the same `layoutId`. Its parent
 * must be `relative isolate`. */
export const ActivePill = memo(Pill)

function Pill({ layoutId, className }: { layoutId: string; className?: string }) {
	return (
		<motion.span
			aria-hidden
			layoutId={layoutId}
			transition={slide}
			className={cn('absolute inset-0 -z-10 rounded-[inherit] bg-surface-muted', className)}
		/>
	)
}

const RECEIPT_MS = 2000

/** True for two seconds after each successful save. `savedAt` must change per save, or a repeat save shows nothing. */
function useReceipt(savedAt: number) {
	const [showing, setShowing] = useState(false)
	useEffect(() => {
		// A mutation that gets reset zeroes its stamp, and the receipt goes with it.
		if (savedAt === 0) {
			setShowing(false)
			return
		}
		setShowing(true)
		const timer = setTimeout(() => setShowing(false), RECEIPT_MS)
		return () => clearTimeout(timer)
	}, [savedAt])
	return showing
}

/**
 * The Save a FormSection ends with: submits it, shows the Cmd/Ctrl+S that does the same, then reports the result.
 * It turns primary only while the section has unsaved changes, so a page of sections shows one primary at most where
 * the edit is.
 */
export function SaveButton({
	mutation,
	dirty,
	label = 'Save',
}: {
	mutation: { isPending: boolean; isSuccess: boolean; submittedAt: number }
	/** The section's fields differ from what the server last answered. */
	dirty: boolean
	label?: string
}) {
	const saved = useReceipt(mutation.isSuccess ? mutation.submittedAt : 0)
	if (saved) {
		return (
			<Button type='submit' variant='default'>
				<IconCheck className='text-success' />
				Saved
			</Button>
		)
	}
	return (
		<Button type='submit' variant={dirty ? 'primary' : 'default'} disabled={mutation.isPending}>
			<IconDeviceFloppy />
			{mutation.isPending ? 'Saving…' : label}
			<Keys keys={[mod, 'S']} />
		</Button>
	)
}

// Each layer blurs harder and covers less, so the blur ramps up toward the bottom edge instead of starting at a line.
const BLUR_LAYERS = [1, 2, 4, 8, 16]

/**
 * What sits over the bottom of a scroll region with more below: a progressive blur the rows sink into, and a glass
 * pill counting them that scrolls to the end. The parent is `relative`. It stays mounted and fades both ways; hidden,
 * it is `invisible`, so it paints nothing and the pill leaves the tab order.
 */
export function MoreBelow({ count, noun = 'more', onReveal }: { count: number; noun?: string; onReveal: () => void }) {
	const shown = count > 0
	// The pill keeps the last count it had while it fades out, instead of reading 0 on the way.
	const [label, setLabel] = useState(count)
	if (shown && count !== label) setLabel(count)
	const band = 100 / BLUR_LAYERS.length
	// Each layer fades itself: an ancestor below full opacity would cut its backdrop-filter off from the rows behind,
	// and the blur would vanish for the whole fade and pop back at the end.
	const fade = cn(
		'transition-[opacity,visibility] duration-160 ease-standard',
		shown ? 'visible opacity-100' : 'invisible opacity-0',
	)
	return (
		<>
			<div aria-hidden className='pointer-events-none absolute inset-x-0 bottom-0 z-20 h-20'>
				{BLUR_LAYERS.map((blur, index) => {
					const start = index * band
					const mask = `linear-gradient(to bottom, transparent ${start}%, black ${Math.min(start + band, 100)}%)`
					return (
						<div
							key={blur}
							className={cn('absolute inset-0', fade)}
							style={{ backdropFilter: `blur(${blur}px)`, maskImage: mask, WebkitMaskImage: mask }}
						/>
					)
				})}
				<div className={cn('absolute inset-0 bg-linear-to-b from-transparent to-surface/70', fade)} />
			</div>
			<button
				type='button'
				onClick={onReveal}
				aria-label={`${label} ${noun} below, scroll to the end`}
				className={cn(
					'absolute bottom-3 left-1/2 z-30 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-control border bg-surface-raised pr-3 pl-2 text-xs text-foreground shadow-raised transition-[opacity,visibility,scale,border-color] duration-160 ease-standard hover:border-border-strong',
					shown ? 'visible scale-100 opacity-100' : 'invisible scale-95 opacity-0',
				)}
			>
				<IconArrowDown stroke={1.75} className='size-4' />
				<span className='font-mono'>{label}</span>
				<span className='text-muted'>{noun}</span>
			</button>
		</>
	)
}

/** A titled block of a page: a table, a chart, a list. Not a form; that is a FormSection. */
export function Section({
	title,
	actions,
	children,
	total,
	fill = false,
}: {
	title: string
	actions?: ReactNode
	children: ReactNode
	/** The section's one figure beside its title: how many rows it lists, or what they add up to (`1.2 GB`). */
	total?: number | string
	/** Takes the rest of a `fill` Page's height, and a `DataTable` in it scrolls on its own. It is the last section.
	 * Outside a `fill` Page it is an ordinary section. */
	fill?: boolean
}) {
	const fills = useFill() && fill
	return (
		<section className={fills ? 'flex min-h-72 flex-1 flex-col' : 'mb-8'}>
			<header className='mb-3 flex h-9 items-center justify-between gap-4'>
				<div className='flex min-w-0 items-baseline gap-2.5'>
					<h2 className='shrink-0 text-base font-medium'>{title}</h2>
					{total === undefined ? null : <span className='truncate text-sm text-muted'>{total}</span>}
				</div>
				{actions ? <div className='flex shrink-0 items-center gap-2'>{actions}</div> : null}
			</header>
			<FillContext.Provider value={fills}>{children}</FillContext.Provider>
		</section>
	)
}

/**
 * One group of a settings page: title on top, controls in the body, a hint and the group's own Save in the footer.
 * With `onSave` the card is a form, so its submit button, Enter in a field and Cmd/Ctrl+S all run the browser's
 * validation then `onSave`. Any other button inside must stay `type='button'`, which the primitives already are.
 */
export function FormSection({
	title,
	icon: Icon,
	hint,
	actions,
	aside,
	onSave,
	children,
}: {
	title: string
	icon?: TablerIcon
	/** Footer text: what saving does, or what the group needs before it can. */
	hint?: ReactNode
	actions?: ReactNode
	/** Read-only facts beside the fields: what the server currently answers about what they set. */
	aside?: { label: string; value: ReactNode }[]
	onSave?: () => void
	children: ReactNode
}) {
	const body =
		aside && aside.length > 0 ? (
			<div className='grid gap-x-6 md:grid-cols-[minmax(0,1fr)_13rem]'>
				<div className='min-w-0'>{children}</div>
				<dl className='mt-4 grid content-start gap-2.5 border-t border-border-subtle pt-3 md:mt-0 md:border-t-0 md:border-l md:pt-0 md:pl-5'>
					{aside.map(fact => (
						<div key={fact.label}>
							<dt className='text-xs text-muted'>{fact.label}</dt>
							<dd className='text-sm'>{fact.value}</dd>
						</div>
					))}
				</dl>
			</div>
		) : (
			children
		)
	const card = (
		// Arc's Card is a content tile (media, quick look); a form group draws the same surface by hand.
		<section className='mb-4 rounded-surface border bg-surface'>
			<header className='px-5 pt-5'>
				<h3 className='flex items-center gap-2 text-base font-medium'>
					{Icon ? <Icon className='size-4 text-muted' /> : null}
					{title}
				</h3>
			</header>
			<div className='p-5'>{body}</div>
			{actions || hint ? (
				<footer className='flex min-h-12 flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-5 py-2.5 text-xs text-muted'>
					<span>{hint}</span>
					<div className='ml-auto flex flex-wrap items-center gap-2'>{actions}</div>
				</footer>
			) : null}
		</section>
	)
	if (!onSave) return card
	// A real form, so `required` inputs validate and Enter submits. `data-saves`
	// is what the shell's Cmd/Ctrl+S looks for: it submits the form the caret is
	// in, so a page with several sections saves the one being edited.
	return (
		<form
			data-saves
			onSubmit={event => {
				event.preventDefault()
				onSave()
			}}
		>
			{card}
		</form>
	)
}

/** Readings in one bordered frame, a hairline between them, in a grid that wraps on its own. Each `Cell` draws its own
 * hairline into the 1px gap, so a short last row ends in plain surface instead of a filled block. */
export function Cells({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				'grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-px overflow-hidden rounded-surface border bg-surface',
				className,
			)}
		>
			{children}
		</div>
	)
}

/** One reading in a `Cells` frame: label, the number, then what it is out of. `children` is a sparkline or a bar. */
export function Cell({
	label,
	icon: Icon,
	value,
	hint,
	inline = false,
	children,
}: {
	label: string
	icon?: TablerIcon
	/** Left out by a cell whose body is its content, e.g. a list of facts. */
	value?: ReactNode
	hint?: ReactNode
	/** `children` sit beside the reading instead of under it, and take the width it leaves: a chart in a wide cell.
	 * Decided by the cell's own width, not the window's, so a narrow cell in a wide grid still stacks. */
	inline?: boolean
	children?: ReactNode
}) {
	const reading = (
		<>
			<div className='flex min-h-5.5 items-center gap-2 text-(--text-secondary)'>
				{Icon ? <Icon className='size-4 text-muted' /> : null}
				{label}
			</div>
			{value === undefined ? null : (
				<div
					title={typeof value === 'string' ? value : undefined}
					className='mt-4 truncate font-display text-3xl font-medium'
				>
					{value}
				</div>
			)}
			{hint ? <div className='mt-2 truncate text-muted'>{hint}</div> : null}
		</>
	)
	const card = 'min-w-0 bg-surface p-4 outline outline-border'
	if (inline) {
		return (
			<div className={cn('@container', card)}>
				<div className='@sm:flex @sm:items-stretch @sm:gap-4'>
					<div className='min-w-0 @sm:max-w-[45%] @sm:shrink-0'>{reading}</div>
					<div className='mt-3 min-w-0 @sm:mt-0 @sm:flex-1'>{children}</div>
				</div>
			</div>
		)
	}
	return (
		<div className={card}>
			{reading}
			{children}
		</div>
	)
}

/** Label left, value right, one hairline per row. The shape for attributes that are read, not edited. */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<dl className={cn('divide-y divide-border-subtle rounded-surface border bg-surface px-4', className)}>
			{children}
		</dl>
	)
}

/** One row of a `Facts` list. */
export function Fact({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className='flex min-h-10 items-center gap-4 py-1 text-sm'>
			<dt className='shrink-0 text-muted'>{label}</dt>
			<dd className='min-w-0 flex-1 truncate text-right font-mono text-xs'>{value}</dd>
		</div>
	)
}

/**
 * Facts that are words rather than readings (an image, a health), on one line above a page. `state` opens it as a
 * badge, then label and value pairs; the `grow` item takes the width left over and truncates. Narrower than 42rem it
 * wraps, and the `grow` item gets a line of its own.
 */
export function FactBar({
	state,
	items,
	className,
}: {
	state: ReactNode
	items: { label: string; value: ReactNode; grow?: boolean }[]
	className?: string
}) {
	return (
		<div className={cn('@container', className)}>
			<dl className='flex flex-wrap items-center overflow-hidden rounded-panel border bg-surface text-sm @2xl:h-control-lg @2xl:flex-nowrap'>
				<div className='flex h-10 shrink-0 items-center px-3.5 @2xl:h-full'>
					<dt className='sr-only'>State</dt>
					<dd>{state}</dd>
				</div>
				{items.map(item => (
					<div
						key={item.label}
						className={cn(
							'flex h-10 items-center gap-2 px-3.5 whitespace-nowrap @2xl:h-full @2xl:border-l @2xl:border-border-subtle',
							item.grow ? 'min-w-0 grow basis-full @2xl:basis-0' : 'shrink-0',
						)}
					>
						<dt className='shrink-0 text-secondary'>{item.label}</dt>
						<dd className='min-w-0 truncate'>{item.value}</dd>
					</div>
				))}
			</dl>
		</div>
	)
}

/**
 * A reading and how full it is. `max` is what the bar fills against, so a
 * container without a memory limit reports zero and gets the number alone: a
 * bar with nothing to fill against says less than no bar at all.
 */
export function Meter({
	label,
	value,
	max = 100,
	className,
}: {
	/** What the row reads, e.g. `14%` or `412 MB / 1 GB`. */
	label: ReactNode
	value: number
	max?: number
	className?: string
}) {
	return (
		<div className={cn('flex min-w-24 items-center gap-2', className)}>
			{label === '' ? null : <div className='shrink-0 font-mono text-xs leading-none tabular-nums'>{label}</div>}
			{max > 0 ? (
				<Progress
					value={value}
					max={max}
					aria-label={typeof label === 'string' && label !== '' ? label : undefined}
					className='min-w-10 flex-1'
				/>
			) : null}
		</div>
	)
}

/** The page's headline readings in one `Cells` frame, above everything else it shows. */
export function StatStrip({ items, className }: { items: { label: string; value: ReactNode }[]; className?: string }) {
	return (
		<Cells className={className}>
			{items.map(item => (
				<Cell key={item.label} label={item.label} value={item.value} />
			))}
		</Cells>
	)
}

/** An ordered run of steps, each with the state it ended in. The shape for a pipeline that is watched while it runs. */
export function Timeline({ steps }: { steps: { id: string; name: string; status: string; detail?: ReactNode }[] }) {
	return (
		<ol className='relative ml-[3px] border-l border-border-subtle'>
			{steps.map(step => (
				<li key={step.id} className='flex items-center gap-3 py-1 pl-4 text-sm'>
					<span className='absolute -left-[3.5px]'>
						<Status dot value={step.status} />
					</span>
					<span className='min-w-0 flex-1 truncate font-mono'>{step.name}</span>
					{step.detail ? (
						<span className='shrink-0 font-mono text-xs text-muted tabular-nums'>{step.detail}</span>
					) : null}
				</li>
			))}
		</ol>
	)
}

/** How often a relative stamp is redrawn. The shortest thing `since` says is seconds, so half a minute is enough. */
const RELATIVE_TICK_MS = 30_000

/** A stamp read as distance from now in either direction, re-read on a tick so a page left open does not keep claiming `2m ago`. */
export function RelativeTime({ at }: { at: string | number | null | undefined }) {
	const [, redraw] = useState(0)

	useEffect(() => {
		const timer = setInterval(() => redraw(count => count + 1), RELATIVE_TICK_MS)
		return () => clearInterval(timer)
	}, [])

	if (!at) return <span className='text-muted'>-</span>
	const parsed = typeof at === 'number' ? at * 1000 : Date.parse(at)
	if (Number.isNaN(parsed)) return <span className='text-muted'>-</span>
	const stamp = new Date(parsed)
	return (
		<time dateTime={stamp.toISOString()} title={stamp.toLocaleString()} className='whitespace-nowrap text-muted'>
			{parsed > Date.now() ? until(at) : since(at)}
		</time>
	)
}

export function ErrorText({ error }: { error: unknown }) {
	if (!error) return null
	const message = error instanceof Error ? error.message : String(error)
	return <Alert tone='danger' title={message} className='mb-3' />
}

/** What a list shows when it has nothing to list, with optionally the action that fills it. */
export function EmptyState({
	icon: Icon = IconInbox,
	title,
	description,
	children,
}: {
	icon?: TablerIcon
	title: string
	description?: string
	children?: ReactNode
}) {
	return <ArcEmptyState icon={<Icon stroke={1.5} />} title={title} description={description} action={children} />
}

/** The one way to ask before something unrecoverable. The trigger is whatever `children` renders; a menu item, which
 * closes its menu (and anything inside it) on select, opens it through `open` instead. */
export function Confirm({
	title,
	description,
	action = 'Delete',
	type,
	onConfirm,
	...trigger
}: {
	title: string
	description?: string
	action?: string
	/** A name the reader has to type before the action unlocks, for what takes data with it. */
	type?: string
	onConfirm: () => void
} & ({ children: ReactElement } | { open: boolean; onOpenChange: (open: boolean) => void })) {
	const [ownOpen, setOwnOpen] = useState(false)
	const [typed, setTyped] = useState('')
	const open = 'open' in trigger ? trigger.open : ownOpen
	const setOpen = 'open' in trigger ? trigger.onOpenChange : setOwnOpen
	const locked = type !== undefined && typed.trim() !== type
	return (
		<Dialog
			open={open}
			disablePointerDismissal
			onOpenChange={next => {
				setOpen(next)
				setTyped('')
			}}
		>
			{'children' in trigger ? <DialogTrigger render={trigger.children} /> : null}
			<AlertContent title={title} description={description}>
				{type === undefined ? null : (
					<Field label={`Type ${type} to confirm`}>
						<Input value={typed} onChange={event => setTyped(event.target.value)} autoComplete='off' />
					</Field>
				)}
				<DialogFooter>
					<DialogClose render={<Button variant='ghost'>Cancel</Button>} />
					<Button
						variant='danger'
						disabled={locked}
						onClick={() => {
							setOpen(false)
							onConfirm()
						}}
					>
						<IconTrash />
						{action}
					</Button>
				</DialogFooter>
			</AlertContent>
		</Dialog>
	)
}

/** Arc has no alert dialog: this is its Dialog announced as one. Its Dialog takes `disablePointerDismissal`. */
function AlertContent({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
	return (
		<DialogContent role='alertdialog' title={title} description={description}>
			{children}
		</DialogContent>
	)
}

/** The row of actions at the bottom of a dialog: Cancel, then the one that does it. */
export function DialogFooter({ children }: { children: ReactNode }) {
	return <div className='mt-4 flex flex-wrap justify-end gap-2'>{children}</div>
}

/** Asks before a navigation drops unsaved changes. `useBlocker({ withResolver: true })` drives it. */
export function ConfirmLeave({ blocker }: { blocker: ReturnType<typeof useBlocker> }) {
	return (
		<Dialog
			open={blocker.status === 'blocked'}
			disablePointerDismissal
			onOpenChange={open => {
				if (!open && blocker.status === 'blocked') blocker.reset()
			}}
		>
			<AlertContent
				title='Discard the unsaved changes?'
				description='Leaving drops them. Stay and save to keep them.'
			>
				<DialogFooter>
					<DialogClose render={<Button variant='ghost'>Stay</Button>} />
					<Button
						variant='danger'
						onClick={() => {
							if (blocker.status === 'blocked') blocker.proceed()
						}}
					>
						Discard and leave
					</Button>
				</DialogFooter>
			</AlertContent>
		</Dialog>
	)
}

/**
 * The one way to add to or edit a row of a list: never a form under the table. The caller owns `open`, so a header
 * button and a row action can open the same dialog, and closes it in the mutation's `onSuccess`.
 */
export function FormDialog({
	open,
	onOpenChange,
	title,
	description,
	action,
	icon: Icon,
	mutation,
	onSubmit,
	wide,
	children,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: string
	description?: ReactNode
	action: string
	icon: TablerIcon
	mutation: { isPending: boolean; error: unknown; reset: () => void }
	onSubmit: () => void
	wide?: boolean
	children: ReactNode
}) {
	// A failed attempt's error must not greet the next opening.
	const close = () => {
		mutation.reset()
		onOpenChange(false)
	}
	return (
		<Dialog open={open} onOpenChange={next => (next ? onOpenChange(true) : close())}>
			<DialogContent
				title={title}
				description={description}
				className={wide ? '[--dialog-width:42rem]' : '[--dialog-width:32rem]'}
			>
				<form
					onSubmit={event => {
						event.preventDefault()
						onSubmit()
					}}
				>
					<ErrorText error={mutation.error} />
					<NoFill>{children}</NoFill>
					<DialogFooter>
						<Button variant='ghost' onClick={close}>
							Cancel
						</Button>
						<Button type='submit' variant='primary' loading={mutation.isPending}>
							<Icon />
							{action}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

/**
 * A record opened from a list: a deployment's pipeline, a container's log. Wide and tall enough for a console, and
 * never unfolded under the row, which would push the rest of the list off the screen.
 */
export function DetailDialog({
	open,
	onOpenChange,
	title,
	description,
	children,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: ReactNode
	description?: ReactNode
	children: ReactNode
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={title} description={description} className='[--dialog-width:72rem]'>
				<NoFill>{children}</NoFill>
			</DialogContent>
		</Dialog>
	)
}

/** The only checkbox shape in the app. A <label> around it is safe: the box is a <button>, the label's first labelable child. */
export function Check({
	label,
	name,
	checked,
	onChange,
	disabled,
	muted,
	className,
}: {
	label: string
	/** What names the box when `label` is empty, as in a table's selection column. */
	name?: string
	checked: boolean
	onChange: (checked: boolean) => void
	disabled?: boolean
	muted?: boolean
	/** Layout only (sizing, shrink). Color and spacing stay with the primitive. */
	className?: string
}) {
	return (
		<label className={cn('flex items-center gap-2 text-sm', muted && 'text-muted', className)}>
			<Checkbox
				aria-label={name ?? label}
				checked={checked}
				disabled={disabled}
				onCheckedChange={next => onChange(next === true)}
			/>
			{label}
		</label>
	)
}

/** An on/off setting. A Check picks; a Switch turns something on. */
export function Switch({
	label,
	hint,
	checked,
	onChange,
	disabled,
}: {
	label: string
	hint?: string
	checked: boolean
	onChange: (checked: boolean) => void
	disabled?: boolean
}) {
	return (
		<label className='flex items-start gap-3 text-sm'>
			<ArcSwitch checked={checked} disabled={disabled} onCheckedChange={onChange} />
			{/* The switch is a control-md tall hit area; the label's first line centers on it. */}
			<span className='flex flex-col gap-0.5 pt-[calc((var(--spacing-control-md)-1lh)/2)]'>
				{label}
				{hint ? <span className='text-xs text-muted'>{hint}</span> : null}
			</span>
		</label>
	)
}

/** The only picker shape in the app. */
export function Select<TValue extends string>({
	value,
	options,
	onChange,
	required,
	disabled,
	label,
	className,
}: {
	value: TValue
	/** NoInfer: the value type comes from `value` and `onChange`, never widened by the options. */
	options: readonly { value: NoInfer<TValue>; label: string }[]
	onChange: (value: TValue) => void
	required?: boolean
	disabled?: boolean
	/** For a picker with no Field around it, like a page filter. */
	label?: string
	/** Layout only, e.g. a filter that sizes to its content. */
	className?: string
}) {
	return (
		<ArcSelect
			aria-label={label}
			{...useFieldNaming(label)}
			options={[...options]}
			value={value}
			onValueChange={next => {
				const picked = options.find(option => option.value === next)
				if (picked) onChange(picked.value)
			}}
			required={required}
			disabled={disabled}
			className={className}
		/>
	)
}

/** A Select with a search box, for a long list from a provider. Under a hundred fixed choices, use Select. */
export function Combo<TValue extends string>({
	label,
	value,
	options,
	onChange,
	disabled,
	placeholder = 'Select',
	empty = 'No matches',
	custom,
}: {
	/** The accessible name; Field's label names the group, not the input inside it. */
	label: string
	value: TValue | ''
	options: readonly { value: NoInfer<TValue>; label: string }[]
	/** `''` when the picked value is cleared. */
	onChange: (value: TValue | '') => void
	disabled?: boolean
	/** Shown while nothing is picked yet, or while the list is still loading. */
	placeholder?: string
	/** Shown when the search matches nothing. */
	empty?: string
	/** Makes the search box a value of its own, for a field whose options are suggestions. */
	custom?: (value: string) => void
}) {
	return (
		<Combobox
			aria-label={label}
			{...useFieldNaming(label)}
			options={[...options]}
			value={value}
			onValueChange={next => onChange(options.find(option => option.value === next)?.value ?? '')}
			onCustomValue={custom}
			disabled={disabled}
			placeholder={placeholder}
			emptyMessage={empty}
		/>
	)
}

/** `mono` is for machine text typed by hand: a variable name, a value, an id. A password gets Arc's show/hide toggle. */
export function Input({ mono, ...props }: Omit<ComponentProps<typeof ArcInput>, 'className'> & { mono?: boolean }) {
	const naming = useFieldNaming(props['aria-label'])
	if (props.type === 'password') return <PasswordField className={cn(mono && 'font-mono')} {...naming} {...props} />
	return <ArcInput className={cn(mono && 'font-mono')} {...naming} {...props} />
}

export function Textarea({
	mono,
	...props
}: Omit<ComponentProps<typeof ArcTextarea>, 'className'> & { mono?: boolean }) {
	return <ArcTextarea className={cn(mono && 'font-mono')} {...useFieldNaming(props['aria-label'])} {...props} />
}

const FieldContext = createContext<{ labelId: string; hintId: string | undefined } | null>(null)

/** Field's label names the group, so the control inside takes it too; an own aria-label wins. */
function useFieldNaming(ariaLabel: string | undefined) {
	const field = useContext(FieldContext)
	return {
		'aria-labelledby': ariaLabel ? undefined : field?.labelId,
		'aria-describedby': field?.hintId,
	}
}

/** A label over one control, styled as Arc's own. A group, not a <label>: a field can hold a switch row or a picker
 * that already labels itself. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	const labelId = useId()
	const hintId = useId()
	const naming = useMemo(() => ({ labelId, hintId: hint ? hintId : undefined }), [labelId, hintId, hint])
	return (
		<div role='group' aria-labelledby={labelId} className='mb-4 grid content-start gap-2'>
			<span id={labelId} className='text-sm font-medium'>
				{label}
			</span>
			<FieldContext value={naming}>{children}</FieldContext>
			{hint ? (
				<span id={hintId} className='text-xs text-muted'>
					{hint}
				</span>
			) : null}
		</div>
	)
}
