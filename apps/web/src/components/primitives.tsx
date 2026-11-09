import {
	type ComponentProps,
	createContext,
	type ReactElement,
	type ReactNode,
	isValidElement,
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
	IconClock,
	IconDeviceFloppy,
	IconInbox,
	IconInfoCircle,
	IconPlayerStop,
	IconProgress,
	IconRefresh,
	IconTrash,
	IconX,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { type Query, useIsFetching, useMutation, useQueryClient } from '@tanstack/react-query'
import { type useBlocker, useMatch, useRouter, useRouterState } from '@tanstack/react-router'
import { cn } from 'cn'
import { motion } from 'motion/react'
import { createPortal } from 'react-dom'
import { Alert } from '@/components/ui/alert'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Breadcrumb } from '@/components/ui/breadcrumb'
import { Button as ArcButton } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { EmptyState as ArcEmptyState } from '@/components/ui/empty-state'
import { EmptyScene, type EmptySceneId } from '@/components/ui/empty-states'
import { Input as ArcInput } from '@/components/ui/input'
import { NumberField as ArcNumberField } from '@/components/ui/number-field'
import { PasswordField } from '@/components/ui/password-field'
import { Progress } from '@/components/ui/progress'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select as ArcSelect } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Stepper } from '@/components/ui/stepper'
import { Switch as ArcSwitch } from '@/components/ui/switch'
import { Tabs as ArcTabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea as ArcTextarea } from '@/components/ui/textarea'
import { Tooltip } from '@/components/ui/tooltip'
import { labelOf, trailOf } from '@/lib/breadcrumb'
import { since, until } from '@/lib/format'
import { motionTokens } from '@/lib/motion'

// The rules every primitive below follows: Arc UI's look (components/ui, tokens in styles.css), one primary
// action per view, sentence case everywhere, an icon on every action.

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

// Intent names, so pages never spell out Arc's "secondary".
const buttonVariants = {
	default: 'secondary',
	primary: 'primary',
	danger: 'danger',
	ghost: 'ghost',
} as const satisfies Record<ButtonVariant, NonNullable<ComponentProps<typeof ArcButton>['variant']>>

type ButtonProps = Omit<ComponentProps<typeof ArcButton>, 'variant' | 'size' | 'icon' | 'className'>

// Only the intent and IconButton's two sizes are ours; everything else passes through, so a Button can be a menu
// trigger (it takes the trigger's handlers and ref) or, with `render`, a router link.
export function Button({
	variant = 'default',
	size = 'default',
	type = 'button',
	...props
}: ButtonProps & { variant?: ButtonVariant; size?: 'sm' | 'default' }) {
	return <ArcButton type={type} variant={buttonVariants[variant]} size={size === 'sm' ? 'sm' : 'md'} {...props} />
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
				// A menu opened from this button keeps it lit, as Arc's own menu trigger stays while its menu is up.
				className='data-popup-open:bg-surface-muted data-popup-open:text-foreground'
				aria-label={label}
				{...props}
			>
				<Icon size={16} stroke={1.75} />
			</ArcButton>
		</Tooltip>
	)
}

/** Text that links: the underline fades in on hover and a press scales it (`press` carries the fade, so no
 * `transition-*` beside it). A touch has no hover, so the press draws the underline too. */
export const textLink =
	'press underline decoration-transparent underline-offset-4 hover:decoration-current active:decoration-current'

/** navigator.platform is deprecated but still the one signal every browser ships. Unset during the prerender. */
export const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? '⌘' : 'Ctrl'

/**
 * A key combination shown next to the thing it triggers, one cap per key:
 * `<Keys keys={[mod, 'K']} />`. Arc has no key cap, so this is one drawn on its tokens. The caps are hidden from
 * screen readers; the control they sit in names its shortcut in `aria-keyshortcuts`.
 */
export function Keys({ keys }: { keys: string[] }) {
	return (
		// A phone's keyboard has no Cmd or Ctrl, so a touch screen hides the caps.
		<span aria-hidden='true' className='inline-flex items-center gap-0.5 pointer-coarse:hidden'>
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
	customer: 'success',
	'opens on deploy': 'warning',
	'closes on deploy': 'warning',
	starting: 'warning',
	restarting: 'warning',
	pending: 'warning',
	connecting: 'warning',
	refused: 'danger',
	unhealthy: 'danger',
	failed: 'danger',
	expired: 'danger',
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

/** A run (a deployment, a task run) that is `running` is still going, where a container that is `running` is up. */
const runLooks: Record<string, { tone: BadgeTone; icon: TablerIcon }> = {
	queued: { tone: 'neutral', icon: IconClock },
	running: { tone: 'info', icon: IconProgress },
	cancelled: { tone: 'warning', icon: IconAlertTriangle },
}

/** The API spells `cancelled` the British way; the dashboard's words are American. */
const words: Record<string, string> = { cancelled: 'canceled' }
export const statusWord = (value: string) => words[value] ?? value

function look(value: string, run: boolean | undefined) {
	const forRun = run ? runLooks[value] : undefined
	if (forRun) return forRun
	const tone = stateTones[value] ?? 'neutral'
	return { tone, icon: toneIcons[tone] }
}

/** A deployment's or task run's tone and icon, the same pair `Status run` draws. */
export const runLook = (status: string) => look(status, true)

/** A state as an Arc badge: tone, icon and word together. `dot` drops the word for rows that are tight; `run` reads
 * the value as a deployment's or a task run's status. */
export function Status({ value, dot, run }: { value: string; dot?: boolean; run?: boolean }) {
	if (!value) return <span className='text-muted'>-</span>
	const { tone, icon: Icon } = look(value, run)
	const word = statusWord(value)
	if (dot) {
		return (
			<span
				role='img'
				title={word}
				aria-label={word}
				className={cn('inline-block size-1.5 shrink-0 rounded-full bg-current', toneText[tone])}
			/>
		)
	}
	return (
		<Badge tone={tone} icon={<Icon size={13} stroke={2} />}>
			{word}
		</Badge>
	)
}

/** Re-fetches a section's data. Lives in the section header, next to its title. Only its own click turns it into a
 * spinner: a poll or a server event refetching the same query leaves it still. `label` names what it reloads where a
 * page has two, so the buttons do not share one name. */
export function Refresh({ onClick, label = 'Refresh' }: { onClick: () => Promise<unknown>; label?: string }) {
	const refresh = useMutation({ mutationFn: onClick })
	return <IconButton icon={IconRefresh} label={label} loading={refresh.isPending} onClick={() => refresh.mutate()} />
}

const ChromeContext = createContext<HTMLElement | null>(null)

/** True inside a Page's content: a child route's pending Page (`router.tsx`) renders there and must not draw a second
 * header or a second `main`. */
const InPageContext = createContext(false)

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
	index,
	actions,
	toolbar,
	filters,
	fill = false,
	children,
}: {
	labels?: Record<string, ReactNode>
	/** What this page is about, for the tab, when the URL only has an id. */
	name?: string
	/** The h1 on the layout's own URL (its first tab), where the last segment joins the trail instead. */
	index?: string
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
	// The URL moves when a navigation starts, the page when it lands: the header names the page still on screen.
	const pathname = useRouterState({ select: state => state.matches.at(-1)?.pathname ?? state.location.pathname })
	// The match that renders the not-found page: status `notFound` below the root, `_notFound` with status `success` at
	// the root (router-core load-client). A pending match on its way to a real page is neither.
	const notFound = useRouterState({
		select: state => state.matches.some(match => match.status === 'notFound' || match._notFound === true),
	})
	const header = useContext(ChromeContext)
	const nested = useContext(InPageContext)
	// The route that renders this Page; its own URL is the layout's index, the first tab.
	const layoutPath = useMatch({ strict: false, select: match => match.pathname })
	const trail = trailOf(pathname, Object.keys(router.routesByPath)).filter(
		({ segment }) => labels?.[segment] !== null,
	)

	// The tab is named after the deepest thing the URL says, then what the page
	// is inside of: Logs · storefront-web · Vexdock. A segment standing in for an
	// id is labeled with a picker, which says nothing in a tab, so `name` speaks for it.
	const tail = trail.at(-1)
	const indexed = !notFound && index !== undefined && pathname.replace(/\/$/u, '') === layoutPath.replace(/\/$/u, '')
	const named = indexed ? index : tail && (labels?.[tail.segment] ?? labelOf(tail.segment))
	const heading = notFound ? 'Page not found' : named
	const title = [typeof heading === 'string' && heading, name, 'Vexdock'].filter(Boolean).join(' · ')
	useEffect(() => {
		if (!nested) document.title = title
	}, [nested, title])

	const parents = indexed || notFound ? trail : trail.slice(0, -1)
	const head = (
		<>
			<div className='grid min-w-0 flex-1 gap-0.5'>
				{/* A labeled segment renders its own picker, never wrapped in a link that would navigate on the click
				    that opens it. Only a plain segment links. */}
				{parents.length > 0 ? (
					<Breadcrumb
						lastIsCurrent={false}
						items={parents.map(({ segment, to, linkable }, position) => ({
							label: labelOf(segment),
							// On a not-found page the last crumb is the layout that did match, a page you can go back to.
							href:
								(linkable || (notFound && position === parents.length - 1)) &&
								labels?.[segment] === undefined
									? to
									: undefined,
							node: labels?.[segment],
						}))}
					/>
				) : null}
				{heading ? (
					<h1 className='flex min-w-0 items-center gap-2 text-2xl font-medium @max-[480px]/shell:text-xl'>
						{typeof heading === 'string' ? <span className='truncate'>{heading}</span> : heading}
					</h1>
				) : null}
			</div>
			{/* Buttons carry their own shrink-0, so this only squeezes text actions. */}
			{actions ? <div className='flex min-w-0 items-center gap-2'>{actions}</div> : null}
		</>
	)

	if (nested) return children
	// Null only on the shell's very first render, before its bar has been
	// committed; it sets it during that commit, so nothing paints without it.
	return (
		<>
			{header ? createPortal(head, header) : null}
			{toolbar || filters ? (
				// Too narrow for both, the filters wrap under the toolbar and start at its left edge.
				<div className='flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b px-6 py-3 @max-[480px]/shell:px-4'>
					{toolbar}
					{filters ? <div className='flex max-w-full min-w-0 items-center gap-2'>{filters}</div> : null}
				</div>
			) : null}
			{/* data-content is what a navigation's page swap snapshots, data-recede what steps back under a dialog
			    (styles.css). */}
			{/* Focused only by the shell's skip link, which moves the reader into the page; a ring around it all is noise. */}
			<main
				id='content'
				tabIndex={-1}
				data-content
				data-recede
				data-scroll-restoration-id='content'
				className={cn(
					'min-h-0 flex-1 overflow-y-auto p-6 outline-none @max-[480px]/shell:px-4',
					fill && 'flex flex-col',
				)}
			>
				<InPageContext.Provider value>
					<FillContext.Provider value={fill}>{children}</FillContext.Provider>
				</InPageContext.Provider>
			</main>
		</>
	)
}

/** The URL's path, or `''` once a URL no route serves has landed (the not-found page), so navigation lights nothing there. */
export function useServedPath() {
	return useRouterState({
		select: state => {
			const path = state.location.pathname
			const served = path.replace(/\/$/u, '') === (state.matches.at(-1)?.pathname ?? '').replace(/\/$/u, '')
			return state.status === 'pending' || served ? path : ''
		},
	})
}

/**
 * Sub-navigation for a Page's `toolbar`. A tab links to `base + suffix`; the
 * empty suffix is the layout's index route and only matches the base itself.
 */
export function Tabs({ base, tabs }: { base: string; tabs: { suffix: string; label: string; count?: number }[] }) {
	const pathname = useServedPath()
	const shown = useRouterState({
		select: state => (state.status === 'pending' ? (state.matches.at(-1)?.pathname ?? '') : ''),
	})
	const tabAt = (path: string) =>
		tabs.find(tab =>
			tab.suffix === '' ? path === base || path === `${base}/` : path.startsWith(base + tab.suffix),
		)
	// A tab answers its click at once; a link out of the layout keeps the shown tab selected until the page swaps.
	// Once it lands, a URL none of the tabs owns (a page not found) selects none.
	const active = tabAt(pathname) ?? tabAt(shown)

	return (
		<ArcTabs value={active?.label ?? ''} className='min-w-0'>
			<TabsList>
				{tabs.map(tab => (
					<TabsTrigger key={tab.label} value={tab.label} href={base + tab.suffix}>
						{tab.label}
						{tab.count ? (
							<span className='text-xs text-muted tabular-nums'>{tab.count.toLocaleString('en-US')}</span>
						) : null}
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
	className,
	disabled = false,
}: {
	value: TValue
	options: readonly { value: NoInfer<TValue>; label: string; icon?: TablerIcon }[]
	onChange: (value: TValue) => void
	/** Names the group for assistive tech; required, since a row of bare words says nothing about what it sets. */
	label: string
	/** Layout only, e.g. hiding it where a Select takes over. */
	className?: string
	disabled?: boolean
}) {
	return (
		// A disabled fieldset disables the buttons inside without forking Arc's control; `contents` keeps it out of layout.
		<fieldset disabled={disabled} className='contents [&:disabled_button]:opacity-50'>
			<SegmentedControl
				// A Field lays its control out in a grid, which would stretch the row across the card.
				className={cn('justify-self-start', className)}
				label={label}
				value={value}
				options={options.map(option => ({
					value: option.value,
					label: option.label,
					icon: option.icon ? <option.icon size={16} stroke={1.75} /> : undefined,
				}))}
				onValueChange={next => {
					const picked = options.find(option => option.value === next)
					if (picked) onChange(picked.value)
				}}
			/>
		</fieldset>
	)
}

/** The selected item's background; it slides from the one selected before within the same `layoutId`. Its parent
 * must be `relative isolate`. */
export const ActivePill = memo(Pill)

function Pill({ layoutId, className }: { layoutId: string; className?: string }) {
	return (
		<motion.span
			aria-hidden
			layoutId={layoutId}
			transition={motionTokens.spring.morph}
			className={cn('absolute inset-0 -z-10 rounded-[inherit] bg-surface-muted', className)}
		/>
	)
}

const RECEIPT_MS = 2000

/** True for two seconds after each successful save. `savedAt` must change per save, or a repeat save shows nothing. */
function useReceipt(savedAt: number) {
	const [expired, setExpired] = useState(0)
	useEffect(() => {
		const timer = setTimeout(() => setExpired(savedAt), RECEIPT_MS)
		return () => clearTimeout(timer)
	}, [savedAt])
	// A mutation that gets reset zeroes its stamp, and the receipt goes with it.
	return savedAt !== 0 && savedAt !== expired
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
	// A new edit ends the receipt early: "Saved" would be untrue for the fields now on screen.
	const showReceipt = saved && !dirty
	let status = ''
	if (showReceipt) status = 'Saved'
	else if (mutation.isPending) status = 'Saving'
	return (
		<>
			{showReceipt ? (
				<Button type='submit' variant='default'>
					<IconCheck size={16} stroke={1.75} className='text-success' />
					Saved
				</Button>
			) : (
				<Button
					type='submit'
					variant={dirty ? 'primary' : 'default'}
					loading={mutation.isPending}
					aria-keyshortcuts='Meta+S Control+S'
				>
					<IconDeviceFloppy size={16} stroke={1.75} />
					{label}
					<Keys keys={[mod, 'S']} />
				</Button>
			)}
			<span role='status' className='sr-only'>
				{status}
			</span>
		</>
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
		'transition-[opacity,visibility]',
		shown ? 'visible opacity-100 duration-170 ease-standard' : 'invisible opacity-0 duration-125 ease-exit',
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
			{/* The wrapper fades the pill in and out, so the button's own transition stays `press`'s. */}
			<div
				className={cn(
					'absolute bottom-3 left-1/2 z-30 -translate-x-1/2 transition-[opacity,visibility,scale]',
					shown
						? 'visible scale-100 opacity-100 duration-170 ease-standard'
						: 'invisible scale-95 opacity-0 duration-125 ease-exit',
				)}
			>
				<button
					type='button'
					onClick={onReveal}
					aria-label={`${label.toLocaleString('en-US')} ${noun} below, scroll to the end`}
					className='flex h-8 press items-center gap-1.5 rounded-control border bg-surface-raised pr-3 pl-2 text-xs text-foreground shadow-raised hover:border-border-strong active:bg-surface-pressed pointer-coarse:h-11'
				>
					<IconArrowDown stroke={1.75} className='size-4' />
					<span className='font-mono'>{label.toLocaleString('en-US')}</span>
					<span className='text-muted'>{noun}</span>
				</button>
			</div>
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
	const headingId = useId()
	return (
		<section aria-labelledby={headingId} className={fills ? 'flex min-h-72 flex-1 flex-col' : 'mb-8'}>
			{/* Actions too wide to share the title's line wrap under it, starting at its left edge. */}
			<header className='mb-3 flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2'>
				<div className='flex min-w-0 items-baseline gap-2.5'>
					<h2 id={headingId} className='shrink-0 text-base font-medium'>
						{title}
					</h2>
					{total === undefined ? null : (
						<span className='truncate text-sm text-muted tabular-nums'>
							{typeof total === 'number' ? total.toLocaleString('en-US') : total}
						</span>
					)}
				</div>
				{actions ? (
					<div className='ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2'>{actions}</div>
				) : null}
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
			// Sized by the card, not the window: beside the 240px rail a 768px window leaves the card 480px.
			<div className='grid gap-x-6 @2xl:grid-cols-[minmax(0,1fr)_13rem]'>
				<div className='min-w-0'>{children}</div>
				<dl className='mt-4 grid content-start gap-2.5 border-t border-border-subtle pt-3 @2xl:mt-0 @2xl:border-t-0 @2xl:border-l @2xl:pt-0 @2xl:pl-5'>
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
	const headingId = useId()
	const card = (
		// Arc's Card is a content tile (media, quick look); a form group draws the same surface by hand.
		<section
			data-slot='form-section'
			aria-labelledby={headingId}
			className='mb-4 rounded-surface border bg-surface'
		>
			<header className='px-5 pt-5'>
				<h2 id={headingId} className='flex items-center gap-2 text-base font-medium'>
					{Icon ? <Icon stroke={1.75} className='size-4 text-muted' /> : null}
					{title}
				</h2>
			</header>
			{/* A card whose body is only an absent error (Delete service) keeps the heading's 20px, not a 40px band. */}
			<div className='@container p-5 empty:pb-0'>{body}</div>
			{actions || hint ? (
				<footer className='flex min-h-12 flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-5 py-2.5 text-xs text-muted'>
					<span>{hint}</span>
					<div className='ml-auto flex flex-wrap items-center justify-end gap-2'>{actions}</div>
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

/** FormSection outlines for a page whose fields are seeded from a read that has not landed yet. */
export function FormSkeleton({ label, cards }: { label: string; cards: number }) {
	return (
		<div>
			<LoadingStatus label={label} />
			{Array.from({ length: cards }, (_, index) => (
				// oxlint-disable-next-line react/no-array-index-key -- outlines carry no identity, only a count
				<section key={index} aria-hidden className='mb-4 rounded-surface border bg-surface'>
					<Skeleton lines={3} className='p-5' />
					<div className='min-h-12 border-t border-border-subtle' />
				</section>
			))}
		</div>
	)
}

/** A screen-reader-only live region, mounted empty and filled after commit: one that mounts already full is not
 * announced. */
export function LoadingStatus({ label }: { label: string }) {
	const [text, setText] = useState('')
	useEffect(() => setText(label), [label])
	return (
		<span role='status' className='sr-only'>
			{text}
		</span>
	)
}

/** A screen-reader-only live region for a result nothing visible names, e.g. a row whose text changes after a Run. */
export function Announcement({ message }: { message: { text: string; at: number } }) {
	// Keyed by time: the same text twice is a new node, so a second identical result is read again.
	return (
		<span role='status' className='sr-only'>
			<span key={message.at}>{message.text}</span>
		</span>
	)
}

/** Readings in one bordered frame, a hairline between them, in a grid that wraps on its own. Each `Cell` draws its own
 * hairline into the 1px gap, so a short last row ends in plain surface instead of a filled block. */
export function Cells({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				// shrink-0: above a fill Section, overflow-hidden would otherwise let the flex column squeeze and clip it.
				'grid shrink-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-px overflow-hidden rounded-surface border bg-surface',
				className,
			)}
		>
			{children}
		</div>
	)
}

/** A `Cell` value still on its way, the width of a figure; a `-` would read as "no value". A `failed` read is that
 * `-`, with its error shown by whatever lists the same query. */
export function PendingReading({ label, failed = false }: { label: string; failed?: boolean }) {
	if (failed) return '-'
	return <Skeleton label={`Loading ${label}`} lines={1} className='w-20' />
}

/** One reading in a `Cells` frame: label, the number, then what it is out of. `children` is a chart or a bar. */
export function Cell({
	label,
	icon: Icon,
	value,
	hint,
	children,
}: {
	label: string
	icon?: TablerIcon
	/** Left out by a cell whose body is its content, e.g. a list of facts. */
	value?: ReactNode
	hint?: ReactNode
	children?: ReactNode
}) {
	return (
		<div className='min-w-0 bg-surface p-4 ring ring-border'>
			<div className='flex min-h-5.5 items-center gap-2 text-secondary'>
				{Icon ? <Icon stroke={1.75} className='size-4 text-muted' /> : null}
				{label}
			</div>
			{value === undefined ? null : (
				<div
					title={typeof value === 'string' ? value : undefined}
					// A RelativeTime is muted beside a row's text, but as the reading itself it is the figure.
					// `min-h-lh` keeps the figure's height while a `PendingReading` skeleton stands in for it.
					className='mt-4 min-h-lh truncate font-display text-3xl/[1.3] font-medium tabular-nums [&_time]:text-current'
				>
					{typeof value === 'number' ? value.toLocaleString('en-US') : value}
				</div>
			)}
			{hint ? (
				<div
					title={typeof hint === 'string' ? hint : undefined}
					className='mt-2 truncate text-muted tabular-nums'
				>
					{hint}
				</div>
			) : null}
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
			<dd className='min-w-0 flex-1 text-right font-mono text-xs wrap-anywhere'>{value}</dd>
		</div>
	)
}

/**
 * Facts that are words rather than readings (an image, a health), on one line above a page. `state` opens it as a
 * badge, then label and value pairs; the `grow` item takes the width left over and wraps inside it, growing the row.
 * Narrower than 42rem the bar wraps, and the `grow` item gets a line of its own.
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
			<dl className='flex flex-wrap items-center overflow-hidden rounded-surface border bg-surface text-sm @2xl:min-h-control-lg @2xl:flex-nowrap'>
				<div className='flex min-h-10 shrink-0 items-center px-3.5 @2xl:self-stretch'>
					<dt className='sr-only'>State</dt>
					<dd>{state}</dd>
				</div>
				{items.map(item => (
					<div
						key={item.label}
						className={cn(
							'flex min-h-10 items-center gap-2 px-3.5 py-1.5 whitespace-nowrap @2xl:self-stretch @2xl:border-l @2xl:border-border-subtle',
							item.grow ? 'min-w-0 grow basis-full @2xl:basis-0' : 'shrink-0',
						)}
					>
						<dt className='shrink-0 text-secondary'>{item.label}</dt>
						<dd className={item.grow ? 'min-w-0 wrap-anywhere whitespace-normal' : undefined}>
							{item.value}
						</dd>
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
			{label === '' ? null : <div className='shrink-0 font-mono text-xs tabular-nums'>{label}</div>}
			{max > 0 ? (
				// The label beside it is the reading; Progress would announce a task's "Progress, 40%" instead.
				<Progress value={value} max={max} aria-hidden className='min-w-10 flex-1' />
			) : null}
		</div>
	)
}

/** The page's headline readings in one `Cells` frame, above everything else it shows. */
export function StatStrip({
	items,
	className,
}: {
	items: { label: string; value: ReactNode; icon?: TablerIcon; hint?: ReactNode }[]
	className?: string
}) {
	return (
		<Cells className={className}>
			{items.map(item => (
				<Cell key={item.label} {...item} />
			))}
		</Cells>
	)
}

/** An ordered run of steps, each with the state it ended in. The shape for a pipeline that is watched while it runs. */
export function Timeline({
	label,
	steps,
}: {
	label: string
	steps: {
		id: string
		name: string
		status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
		detail?: string
	}[]
}) {
	const current = steps.findIndex(step => step.status !== 'success')
	const stepErrors: Partial<Record<(typeof steps)[number]['status'], string>> = {
		failed: 'Failed',
		cancelled: 'Canceled',
	}
	return (
		<Stepper
			label={label}
			orientation='vertical'
			current={current === -1 ? steps.length : current}
			steps={steps.map(step => ({
				id: step.id,
				label: step.name,
				description: step.detail,
				error: stepErrors[step.status],
			}))}
		/>
	)
}

/** A stamp read as distance from now in either direction, re-read on a tick so a page left open does not keep claiming `2m ago`. */
export function RelativeTime({ at, future = false }: { at: string | number | null | undefined; future?: boolean }) {
	const [, redraw] = useState(0)
	const parsed = typeof at === 'number' ? at * 1000 : at ? Date.parse(at) : Number.NaN
	const known = Boolean(at) && !Number.isNaN(parsed)
	// `since` and `until` count seconds under a minute and minutes after it, so the tick follows the unit on screen.
	const ahead = parsed - Date.now()
	let tickMs = Math.abs(ahead) < 60_000 ? 1000 : 30_000
	// A countdown re-reads as it crosses into its last minute, not up to 30 s later.
	if (future && ahead >= 60_000) tickMs = Math.min(30_000, Math.max(1000, ahead - 59_000))

	useEffect(() => {
		if (!known) return
		const timer = setInterval(() => redraw(count => count + 1), tickMs)
		return () => clearInterval(timer)
	}, [known, tickMs])

	if (!known) return <span className='text-muted'>-</span>
	const stamp = new Date(parsed)
	return (
		<time
			dateTime={stamp.toISOString()}
			title={stamp.toLocaleString()}
			className='whitespace-nowrap text-muted tabular-nums'
		>
			{/* A server clock a few seconds ahead must not turn a deploy that just finished into `in 2s`; a scheduled
			    time (`future`) is ahead for real down to the second. */}
			{parsed - Date.now() > (future ? 0 : 60_000) ? until(at) : since(at)}
		</time>
	)
}

export function ErrorText({ error, className }: { error: unknown; className?: string }) {
	const client = useQueryClient()
	// A query's error gets a retry here; a mutation's error is retried by sending its form again.
	const holdsError = (query: Query) => Boolean(error) && query.state.error === error
	const retrying = useIsFetching({ predicate: holdsError }) > 0
	if (!error) return null
	const message = error instanceof Error ? error.message : String(error)
	const failed = client.getQueryCache().getAll().find(holdsError)
	return (
		<Alert tone='danger' title={message} className={cn('mb-3', className)}>
			{failed ? (
				<Button
					loading={retrying}
					onClick={() => client.refetchQueries({ queryKey: failed.queryKey, exact: true })}
				>
					<IconRefresh size={16} stroke={1.75} />
					Try again
				</Button>
			) : undefined}
		</Alert>
	)
}

/** What a list shows when it has nothing to list, with optionally the action that fills it. */
export function EmptyState({
	icon: Icon = IconInbox,
	scene,
	title,
	description,
	heading,
	children,
}: {
	icon?: TablerIcon
	/** An Arc illustration in place of the icon, for a state that fills the page or the list. */
	scene?: EmptySceneId
	title: string
	description?: string
	/** `h2` when nothing but the page's h1 sits above it. */
	heading?: 'h2' | 'h3'
	children?: ReactNode
}) {
	return (
		<ArcEmptyState
			icon={<Icon stroke={1.5} />}
			illustration={scene ? <EmptyScene scene={scene} /> : undefined}
			title={title}
			description={description}
			heading={heading}
			action={children}
		/>
	)
}

/** A list's loading skeleton, then its `EmptyState`, in the frame the loaded list draws. */
export function ListPlaceholder({
	loading,
	label,
	lines,
	children,
}: {
	loading: boolean
	label: string
	lines?: number
	children: ReactNode
}) {
	return (
		<div className='rounded-surface border bg-surface'>
			{loading ? <Skeleton label={label} lines={lines} className='p-5' /> : children}
		</div>
	)
}

/** One applied filter above a list or a report, with the button that drops it. */
export function FilterChip({
	label,
	onRemove,
	children,
}: {
	label: string
	onRemove: () => void
	children: ReactNode
}) {
	return (
		<span className='inline-flex items-center gap-1 rounded-control border bg-surface py-0.5 pr-0.5 pl-2 text-sm'>
			{children}
			<IconButton label={`Remove the ${label} filter`} icon={IconX} onClick={onRemove} />
		</span>
	)
}

/** The one way to ask before something unrecoverable. The trigger is whatever `children` renders; a menu item, which
 * closes its menu (and anything inside it) on select, opens it through `open` instead. */
export function Confirm({
	title,
	description,
	action,
	dismiss = 'Cancel',
	icon: Icon = IconTrash,
	type,
	onConfirm,
	...trigger
}: {
	title: string
	description?: string
	/** A verb with its object (`Delete task`), never a bare verb. */
	action: string
	/** The button that backs out, renamed where the action itself is a cancel. */
	dismiss?: string
	/** For an action whose word is not a removal (Deploy, Save) though its result is. */
	icon?: TablerIcon
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
				{/* A form, so Enter in the typed name confirms once it matches. */}
				<form
					onSubmit={event => {
						event.preventDefault()
						// React bubbles a portaled submit to a form around the trigger, such as a FormSection's.
						event.stopPropagation()
						if (locked) return
						// Closing from here skips the Dialog's onOpenChange, and a name left typed would unlock the next one.
						setTyped('')
						setOpen(false)
						onConfirm()
					}}
				>
					{type === undefined ? null : (
						<Field label={`Type ${type} to confirm`}>
							<Input
								mono
								value={typed}
								onChange={event => setTyped(event.target.value)}
								autoComplete='off'
							/>
						</Field>
					)}
					<DialogFooter>
						<DialogClose render={<Button variant='ghost'>{dismiss}</Button>} />
						<Button type='submit' variant='danger' disabled={locked}>
							<Icon size={16} stroke={1.75} />
							{action}
						</Button>
					</DialogFooter>
				</form>
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
						<IconTrash size={16} stroke={1.75} />
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
	disabled,
	wide,
	children,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: string
	description?: string
	action: string
	icon: TablerIcon
	mutation: { isPending: boolean; error: unknown; reset: () => void }
	onSubmit: () => void
	/** The form cannot be sent yet, such as a picker with nothing picked. */
	disabled?: boolean
	wide?: boolean
	children: ReactNode
}) {
	// A failed attempt's error must not greet the next opening. A request in flight keeps the dialog: closing would
	// reset its mutation, hide a later failure and unlock what waits on it, such as a bulk move's toolbar.
	const close = () => {
		if (mutation.isPending) return
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
						// React bubbles a portaled submit to a form around the trigger, such as a FormSection's.
						event.stopPropagation()
						onSubmit()
					}}
				>
					<ErrorText error={mutation.error} />
					<NoFill>{children}</NoFill>
					<DialogFooter>
						<Button variant='ghost' onClick={close} disabled={mutation.isPending}>
							Cancel
						</Button>
						<Button type='submit' variant='primary' disabled={disabled} loading={mutation.isPending}>
							<Icon size={16} stroke={1.75} />
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
	morph,
	children,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: string
	description?: string
	/** The `--morph` name of the row that opened it, whose `data-morph-from` text becomes the title (the Morph recipe). */
	morph?: string
	children: ReactNode
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={title} description={description} morph={morph} className='[--dialog-width:72rem]'>
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
	indeterminate,
	onChange,
	disabled,
	muted,
	className,
}: {
	label: string
	/** What names the box when `label` is empty, as in a table's selection column. */
	name?: string
	checked: boolean
	/** Some but not all of what it selects, as a select-all box over a partial selection. */
	indeterminate?: boolean
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
				indeterminate={indeterminate}
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
	const labelId = useId()
	const hintId = useId()
	return (
		<label className='flex items-start gap-3 text-sm'>
			{/* Named by the label alone: the hint read as part of the name repeats on every focus. */}
			<ArcSwitch
				checked={checked}
				disabled={disabled}
				onCheckedChange={onChange}
				aria-labelledby={labelId}
				aria-describedby={hint ? hintId : undefined}
			/>
			{/* The switch is a control-md tall hit area; the label's first line centers on it. */}
			<span className='flex flex-col gap-0.5 pt-[calc((var(--spacing-control-md)-1lh)/2)]'>
				<span id={labelId}>{label}</span>
				{hint ? (
					<span id={hintId} className='text-xs text-muted'>
						{hint}
					</span>
				) : null}
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
	placeholder,
	className,
}: {
	value: TValue
	/** NoInfer: the value type comes from `value` and `onChange`, never widened by the options. */
	options: readonly { value: NoInfer<TValue>; label: string }[]
	onChange: (value: TValue) => void
	required?: boolean
	disabled?: boolean
	/** For a picker with no Field around it, like a page filter: names it for assistive tech only. */
	label?: string
	/** Shown while nothing is picked: what to pick, never Arc's generic "Select an option". */
	placeholder?: string
	/** Layout only, e.g. a filter that sizes to its content. */
	className?: string
}) {
	return (
		<ArcSelect
			{...useFieldLabel(label)}
			options={[...options]}
			value={value}
			onValueChange={next => {
				const picked = options.find(option => option.value === next)
				if (picked) onChange(picked.value)
			}}
			required={required}
			disabled={disabled}
			placeholder={placeholder}
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
	/** Names the picker when no Field is around it. */
	label?: string
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
			{...useFieldLabel(label)}
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

type OwnLabel<TProps> = Omit<TProps, 'className' | 'label' | 'description' | 'hideLabel'> & { mono?: boolean }

/** `mono` is for machine text typed by hand: a variable name, a value, an id. A password gets Arc's show/hide toggle.
 * `aria-label` names a control with no Field around it, such as a cell in a table row. */
export function Input({ mono, ...props }: OwnLabel<ComponentProps<typeof ArcInput>>) {
	const naming = useFieldLabel(props['aria-label'])
	const typing = mono ? machineText : undefined
	if (props.type === 'password') {
		return <PasswordField className={cn(mono && 'font-mono')} {...typing} {...naming} {...props} />
	}
	return <ArcInput className={cn(mono && 'font-mono')} {...typing} {...naming} {...props} />
}

export function Textarea({ mono, ...props }: OwnLabel<ComponentProps<typeof ArcTextarea>>) {
	const typing = mono ? machineText : undefined
	return (
		<ArcTextarea
			className={cn(mono && 'font-mono')}
			{...typing}
			{...useFieldLabel(props['aria-label'])}
			{...props}
		/>
	)
}

// Machine text gets no spelling squiggles, and a phone keyboard neither capitalizes nor corrects an identifier.
const machineText = { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } as const

/** A whole number such as a port: digits roll, steppers hold to repeat, the range clamps. Grouping is off, `8080` not `8,080`. */
export function NumberField(props: OwnLabel<ComponentProps<typeof ArcNumberField>>) {
	const { label, description } = useFieldLabel(undefined)
	return <ArcNumberField label={label} description={description} formatOptions={{ useGrouping: false }} {...props} />
}

const FieldContext = createContext<{ label: string; hint: string | undefined; visible: boolean } | null>(null)

/** Arc's controls draw their own label and hint. Inside a Field with one control, they draw the Field's; a control
 * named by its own `ownLabel`, or one of several in a Field, keeps the label for assistive tech only. */
function useFieldLabel(ownLabel: string | undefined) {
	const field = useContext(FieldContext)
	if (ownLabel !== undefined || !field) return { label: ownLabel ?? '', hideLabel: true }
	return { label: field.label, description: field.visible ? field.hint : undefined, hideLabel: !field.visible }
}

const labeledControls = new Set<unknown>([Input, Textarea, Select, Combo, NumberField])

/** A label over one control. An Input, Textarea, Select, Combo or NumberField draws it as Arc's own label and hint; anything else
 * (a switch row, a segmented picker, a control with a button beside it) sits in a group under the label. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	const labelId = useId()
	const hintId = useId()
	const labeled = isValidElement(children) && labeledControls.has(children.type)
	const context = useMemo(() => ({ label, hint, visible: labeled }), [label, hint, labeled])
	if (labeled) {
		return (
			<div className='mb-3 last:mb-0'>
				<FieldContext value={context}>{children}</FieldContext>
			</div>
		)
	}
	return (
		<div
			role='group'
			aria-labelledby={labelId}
			aria-describedby={hint ? hintId : undefined}
			className='mb-3 grid content-start gap-2 last:mb-0'
		>
			<span id={labelId} className='text-sm font-medium'>
				{label}
			</span>
			<FieldContext value={context}>{children}</FieldContext>
			{hint ? (
				<span id={hintId} className='text-xs text-muted'>
					{hint}
				</span>
			) : null}
		</div>
	)
}
