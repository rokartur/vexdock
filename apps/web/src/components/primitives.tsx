import { type ComponentProps, Fragment, type ReactElement, type ReactNode, useState } from 'react'
import {
	IconAlertCircle,
	IconDeviceFloppy,
	IconInbox,
	IconRefresh,
	IconTrash,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { Link, useRouter, useRouterState } from '@tanstack/react-router'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button as ShadcnButton } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field as ShadcnField, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input as ShadcnInput } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Select as ShadcnSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch as ShadcnSwitch } from '@/components/ui/switch'
import { Tabs as ShadcnTabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea as ShadcnTextarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { labelOf, trailOf } from '@/lib/breadcrumb'
import { cn } from '@/utils/cn'

/**
 * The vocabulary every page speaks. Each one wraps a shadcn component so the
 * whole panel inherits one design system, while keeping the dense, flat layout
 * the dashboard needs. Vercel's rules: one black canvas, a hairline border
 * instead of a shadow, white on black for the one primary action, sentence
 * case everywhere, an icon on every action.
 */

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

// Local intent names map onto shadcn variants, so pages never spell out
// "destructive" or "outline" and the mapping can change in one place.
const buttonVariants = {
	default: 'outline',
	primary: 'default',
	danger: 'destructive',
	ghost: 'ghost',
} as const satisfies Record<ButtonVariant, string>

type ButtonProps = Omit<ComponentProps<typeof ShadcnButton>, 'variant' | 'size' | 'className'>

// Only the intent is ours; everything else passes through, so a Button can be
// what a menu trigger renders as and still receive the handlers that needs.
export function Button({ variant = 'default', type = 'button', ...props }: ButtonProps & { variant?: ButtonVariant }) {
	return (
		<ShadcnButton
			type={type}
			variant={buttonVariants[variant]}
			className={cn('text-body', variant === 'ghost' ? 'text-muted-foreground hover:text-foreground' : 'raised')}
			{...props}
		/>
	)
}

/**
 * An icon-only action with its name in a tooltip: row actions, the refresh in a
 * section header, the rail's buttons. `sm` is the row size; `default` matches
 * the buttons it sits next to in a header.
 */
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
		<Tooltip>
			<TooltipTrigger
				render={
					<ShadcnButton
						type='button'
						variant={buttonVariants[variant]}
						size={size === 'sm' ? 'icon-sm' : 'icon'}
						aria-label={label}
						// Rendered as a Link when `render` is given, so base-ui must not expect a <button>.
						nativeButton={props.render === undefined}
						// A pressed toggle (follow, wrap) reads as its hover state kept on.
						className={cn(
							variant === 'ghost' ? 'text-muted-foreground hover:text-foreground' : 'raised',
							'aria-pressed:bg-muted aria-pressed:text-foreground',
						)}
						{...props}
					/>
				}
			>
				<Icon />
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

/**
 * The modifier the platform expects: ⌘ on Apple hardware, Ctrl elsewhere.
 * navigator.platform is deprecated but still the one signal every browser
 * ships. Unset during the prerender, which never renders the shell anyway.
 */
export const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? '⌘' : 'Ctrl'

/**
 * A key combination shown next to the thing it triggers, one cap per key:
 * `<Keys keys={[mod, 'K']} />`. Inside a button it takes the button's colour.
 */
export function Keys({ keys }: { keys: string[] }) {
	return (
		<KbdGroup>
			{keys.map(key => (
				<Kbd key={key} className='in-data-[slot=button]:bg-current/15 in-data-[slot=button]:text-current'>
					{key}
				</Kbd>
			))}
		</KbdGroup>
	)
}

const stateColor: Record<string, string> = {
	running: 'text-emerald-400',
	healthy: 'text-emerald-400',
	success: 'text-emerald-400',
	issued: 'text-emerald-400',
	starting: 'text-amber-400',
	queued: 'text-amber-400',
	restarting: 'text-amber-400',
	pending: 'text-amber-400',
	unhealthy: 'text-red-400',
	failed: 'text-red-400',
	dead: 'text-red-400',
	exited: 'text-muted-foreground',
	stopped: 'text-muted-foreground',
	cancelled: 'text-muted-foreground',
	created: 'text-muted-foreground',
	paused: 'text-muted-foreground',
}

/** A status word rendered in the colour that matches its meaning. */
export function Status({ value }: { value: string }) {
	if (!value) return <span className='text-muted-foreground'>-</span>
	return (
		<span className={cn('inline-flex items-center gap-1.5', stateColor[value] ?? 'text-muted-foreground')}>
			<span aria-hidden className='inline-block size-1.5 rounded-full bg-current' />
			{value}
		</span>
	)
}

/** Re-fetches a section's data. Lives in the section header, next to its title. */
export function Refresh({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
	return <IconButton icon={IconRefresh} label='Refresh' onClick={onClick} disabled={busy} />
}

/**
 * Fills the shell's content panel: a fixed title bar with optional actions,
 * then the scrolling body. Every page is a Page; nothing else scrolls.
 *
 * The header trail is read off the URL, so a page never spells out its own
 * ancestors: /projects/api/settings renders Projects / api / Settings. Pass
 * `labels` to name segments the URL cannot, keyed by segment: an id becomes
 * the project's name, and that same label is reused once the page is an
 * ancestor of a deeper one. A labelled segment is never wrapped in a link,
 * so the label can carry its own interaction. A label of `null` drops its
 * segment from the trail, for path parts that exist only to nest routes.
 */
export function Page({
	labels,
	actions,
	toolbar,
	filters,
	children,
}: {
	labels?: Record<string, ReactNode>
	actions?: ReactNode
	/** Sub-navigation, on the left of the row under the header. */
	toolbar?: ReactNode
	/** What narrows the page, on the right of that same row. */
	filters?: ReactNode
	children: ReactNode
}) {
	const router = useRouter()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const trail = trailOf(pathname, Object.keys(router.routesByPath)).filter(
		({ segment }) => labels?.[segment] !== null,
	)

	return (
		<>
			{/* pr-14 on small screens keeps the actions clear of the shell's sidebar toggle. */}
			<header className='flex h-12 shrink-0 items-center justify-between gap-3 border-b px-5 pr-14 md:pr-5'>
				<Breadcrumb className='min-w-0 flex-1'>
					<BreadcrumbList className='flex-nowrap gap-2 overflow-hidden text-body sm:gap-2'>
						{trail.map(({ segment, to, linkable }, index) => {
							const label = labels?.[segment]
							const last = index === trail.length - 1
							// A supplied label owns its own interaction: the pickers render a
							// button, and wrapping that in a link would navigate on the click
							// that opens the popover. Only a plain last segment is the "page"
							// (aria-current); a picker or an ancestor is a bare span, never a
							// disabled link.
							const crumbClass = cn(
								'flex min-w-0 items-center gap-2 truncate',
								last ? 'font-medium text-foreground' : 'text-muted-foreground',
							)
							let crumb: ReactNode
							if (linkable && label === undefined) {
								crumb = (
									<BreadcrumbLink render={<Link to={to} />} className='truncate'>
										{labelOf(segment)}
									</BreadcrumbLink>
								)
							} else if (last && label === undefined) {
								crumb = <BreadcrumbPage className={crumbClass}>{labelOf(segment)}</BreadcrumbPage>
							} else {
								crumb = <span className={crumbClass}>{label ?? labelOf(segment)}</span>
							}
							return (
								<Fragment key={to}>
									{index > 0 ? (
										<BreadcrumbSeparator className='text-muted-foreground/60'>
											/
										</BreadcrumbSeparator>
									) : null}
									<BreadcrumbItem className='min-w-0 gap-2'>{crumb}</BreadcrumbItem>
								</Fragment>
							)
						})}
					</BreadcrumbList>
				</Breadcrumb>
				{actions ? <div className='flex shrink-0 items-center gap-2'>{actions}</div> : null}
			</header>
			{toolbar || filters ? (
				<div className='flex h-10 shrink-0 items-center gap-4 border-b px-3'>
					{toolbar}
					<div className='ml-auto flex items-center gap-2 pr-2'>{filters}</div>
				</div>
			) : null}
			<div className='min-h-0 flex-1 overflow-y-auto px-5 py-5'>{children}</div>
		</>
	)
}

/**
 * Sub-navigation for a Page's `toolbar`, Vercel's underlined tabs: the active
 * one carries a 2px line on the band's own hairline. A tab links to
 * `base + suffix`; the empty suffix is the layout's index route and only
 * matches the base itself.
 */
export function Tabs({ base, tabs }: { base: string; tabs: { suffix: string; label: string }[] }) {
	const pathname = useRouterState({ select: state => state.location.pathname })
	const active = tabs.find(tab =>
		tab.suffix === '' ? pathname === base || pathname === `${base}/` : pathname.startsWith(base + tab.suffix),
	)

	return (
		<ShadcnTabs value={active?.label ?? ''} className='h-full'>
			<TabsList variant='line' className='h-full gap-0 p-0'>
				{tabs.map(tab => (
					<TabsTrigger
						key={tab.label}
						value={tab.label}
						render={<Link to={base + tab.suffix} />}
						nativeButton={false}
						className='h-full rounded-none px-3 text-body after:bottom-0'
					>
						{tab.label}
					</TabsTrigger>
				))}
			</TabsList>
		</ShadcnTabs>
	)
}

/**
 * A joined row of options switching a value instead of the URL: ranges,
 * filters, modes. An option may carry an icon, which is how a row of sources
 * (GitHub, GitLab, an image) reads as the brands it names rather than a list
 * of words.
 */
export function Segmented<TValue extends string>({
	value,
	options,
	onChange,
}: {
	value: TValue
	options: readonly { value: NoInfer<TValue>; label: string; icon?: TablerIcon }[]
	onChange: (value: TValue) => void
}) {
	return (
		<ToggleGroup
			variant='outline'
			spacing={0}
			value={[value]}
			onValueChange={next => {
				// Pressing the selected option again would clear the group; a switch
				// always has a position, so that press is a no-op.
				const [selected] = next as TValue[]
				if (selected !== undefined) onChange(selected)
			}}
		>
			{options.map(option => (
				<ToggleGroupItem
					key={option.value}
					value={option.value}
					className='text-body text-muted-foreground aria-pressed:bg-foreground aria-pressed:text-background'
				>
					{option.icon ? <option.icon /> : null}
					{option.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	)
}

/** The Save a FormSection ends with: submits it, and shows the Cmd/Ctrl+S that does the same. */
export function SaveButton({ pending, label = 'Save' }: { pending: boolean; label?: string }) {
	return (
		<Button type='submit' variant='primary' disabled={pending}>
			<IconDeviceFloppy />
			{pending ? 'Saving…' : label}
			<Keys keys={[mod, 'S']} />
		</Button>
	)
}

/** A titled block of a page: a table, a chart, a list. Not a form; that is a FormSection. */
export function Section({
	title,
	actions,
	children,
	description,
}: {
	title: string
	actions?: ReactNode
	children: ReactNode
	description?: string
}) {
	return (
		<section className='mb-8'>
			<header className='mb-3 flex h-8 items-center justify-between gap-4'>
				<div className='flex items-baseline gap-2.5'>
					<h2 className='text-title font-medium'>{title}</h2>
					{description ? <span className='text-label text-muted-foreground'>{description}</span> : null}
				</div>
				{actions ? <div className='flex items-center gap-2'>{actions}</div> : null}
			</header>
			{children}
		</section>
	)
}

/**
 * One group of a settings page, Vercel's card: what it is on top, its controls
 * in the body, and a footer strip with a hint on the left and the group's own
 * Save on the right. Each group saves on its own, so its Save goes in
 * `actions`, never in a page-wide bar.
 *
 * With `onSave` the card is a form: its submit button, Enter in a field and
 * Cmd/Ctrl+S all run the browser's own validation (`required`, `min`) and then
 * `onSave`. Any other button inside must stay `type='button'`, which the
 * primitives already are.
 */
export function FormSection({
	title,
	description,
	icon: Icon,
	hint,
	actions,
	onSave,
	children,
}: {
	title: string
	description?: string
	icon?: TablerIcon
	/** Footer text: what saving does, or what the group needs before it can. */
	hint?: ReactNode
	actions?: ReactNode
	onSave?: () => void
	children: ReactNode
}) {
	const card = (
		<Card className='mb-4 gap-0 py-0 raised ring-border'>
			<CardHeader className='gap-0.5 px-5 pt-4'>
				<CardTitle className='flex items-center gap-2 text-title'>
					{Icon ? <Icon className='size-4 text-muted-foreground' /> : null}
					{title}
				</CardTitle>
				{description ? <CardDescription className='text-label'>{description}</CardDescription> : null}
			</CardHeader>
			<CardContent className='px-5 py-4'>{children}</CardContent>
			{actions || hint ? (
				<CardFooter className='min-h-12 justify-between gap-3 border-rule px-5 py-2.5 text-label text-muted-foreground'>
					<span>{hint}</span>
					<div className='flex items-center gap-2'>{actions}</div>
				</CardFooter>
			) : null}
		</Card>
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

/**
 * A row of readings sharing hairlines: one bordered card whose cells split it
 * into equal readings. Children supply their own padding and must not draw
 * their own border: each cell outlines itself into the 1px gap, so a short
 * last row leaves plain card behind it rather than a slab of border colour.
 */
export function Cells({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				'grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-px overflow-hidden rounded-xl border bg-card [&>*]:bg-card [&>*]:outline [&>*]:outline-1 [&>*]:outline-border',
				// The lit edge belongs to the grid's own top row, not to every cell: an
				// interior cell is not raised above the one above it.
				'raised',
				className,
			)}
		>
			{children}
		</div>
	)
}

/**
 * One reading in a `Cells` grid: a label, the number, an optional line under it.
 * `children` is for whatever the reading draws below itself, like a sparkline or
 * a fill bar. Borderless, because the grid owns the hairlines.
 */
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
		<div className='px-4 py-3'>
			<div className='flex items-center gap-1.5 text-label text-muted-foreground'>
				{Icon ? <Icon className='size-3.5' /> : null}
				{label}
			</div>
			{value === undefined ? null : (
				<div className='mt-0.5 truncate text-reading font-semibold tracking-tight'>{value}</div>
			)}
			{hint ? <div className='mt-0.5 truncate text-meta text-muted-foreground'>{hint}</div> : null}
			{children}
		</div>
	)
}

/**
 * A list of facts: label on the left, value on the right, one hairline per row.
 * The shape the panel uses wherever a set of attributes is read, not edited.
 */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<ItemGroup
			className={cn(
				'gap-0 rounded-xl border bg-card px-3 raised [&>*+*]:border-t [&>*+*]:border-rule',
				className,
			)}
		>
			{children}
		</ItemGroup>
	)
}

/** One row of a `Facts` list. */
export function Fact({ label, value }: { label: string; value: ReactNode }) {
	return (
		<Item size='sm' className='min-h-9 flex-nowrap rounded-none border-x-0 border-b-0 px-0 py-1 text-body'>
			<ItemContent className='shrink-0'>
				<ItemTitle className='font-normal text-muted-foreground'>{label}</ItemTitle>
			</ItemContent>
			<ItemActions className='min-w-0 flex-1 justify-end truncate text-right font-mono text-label'>
				{value}
			</ItemActions>
		</Item>
	)
}

export function ErrorText({ error }: { error: unknown }) {
	if (!error) return null
	const message = error instanceof Error ? error.message : String(error)
	return (
		<Alert variant='destructive' className='mb-3 text-body'>
			<IconAlertCircle />
			<AlertDescription className='text-body'>{message}</AlertDescription>
		</Alert>
	)
}

/**
 * What a list shows when it has nothing to list: an icon, a line, and
 * optionally the action that fills it.
 */
export function EmptyState({
	icon: Icon = IconInbox,
	title,
	description,
	children,
}: {
	icon?: TablerIcon
	title: ReactNode
	description?: ReactNode
	children?: ReactNode
}) {
	return (
		<Empty className='gap-3 border-0 py-8'>
			<EmptyHeader className='gap-1'>
				<EmptyMedia variant='icon' className='mb-1'>
					<Icon />
				</EmptyMedia>
				<EmptyTitle className='text-body font-medium'>{title}</EmptyTitle>
				{description ? <EmptyDescription className='text-label'>{description}</EmptyDescription> : null}
			</EmptyHeader>
			{children ? <EmptyContent>{children}</EmptyContent> : null}
		</Empty>
	)
}

/**
 * The one way to ask before something unrecoverable. The trigger is whatever
 * `children` renders; the dialog names the action and does it on confirm.
 */
export function Confirm({
	title,
	description,
	action = 'Delete',
	onConfirm,
	children,
}: {
	title: string
	description?: string
	action?: string
	onConfirm: () => void
	children: ReactElement
}) {
	// Owned state: base-ui's alert dialog has no Action part that closes, only
	// Cancel does, so confirming has to close it by hand.
	const [open, setOpen] = useState(false)
	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger render={children} />
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					{description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant='destructive'
						onClick={() => {
							setOpen(false)
							onConfirm()
						}}
					>
						<IconTrash />
						{action}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

/**
 * The only checkbox shape in the app, for picking things out of a list.
 * Wrapping in a <label> is safe: base-ui's Checkbox renders a visually hidden
 * native input, so clicking the text toggles it.
 */
export function Check({
	label,
	checked,
	onChange,
	disabled,
	muted,
	className,
}: {
	label: string
	checked: boolean
	onChange: (checked: boolean) => void
	disabled?: boolean
	muted?: boolean
	/** Layout only (sizing, shrink). Colour and spacing stay with the primitive. */
	className?: string
}) {
	return (
		<label className={cn('flex items-center gap-2 text-body', muted && 'text-muted-foreground', className)}>
			<Checkbox checked={checked} disabled={disabled} onCheckedChange={onChange} />
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
		<label className='flex items-start gap-3 text-body'>
			<ShadcnSwitch checked={checked} disabled={disabled} onCheckedChange={onChange} className='mt-0.5' />
			<span className='flex flex-col gap-0.5'>
				{label}
				{hint ? <span className='text-label text-muted-foreground'>{hint}</span> : null}
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
		<ShadcnSelect
			items={options}
			value={value}
			onValueChange={next => {
				if (next !== null) onChange(next)
			}}
			required={required}
			disabled={disabled}
		>
			<SelectTrigger aria-label={label} className={cn('w-full text-body', className)}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent alignItemWithTrigger={false}>
				{options.map(option => (
					<SelectItem key={option.value} value={option.value} className='text-body'>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</ShadcnSelect>
	)
}

export function Input(props: Omit<ComponentProps<typeof ShadcnInput>, 'className'>) {
	return <ShadcnInput className='text-body md:text-body' {...props} />
}

export function Textarea(props: Omit<ComponentProps<typeof ShadcnTextarea>, 'className'>) {
	return <ShadcnTextarea className='min-h-20 text-body md:text-body' {...props} />
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<ShadcnField className='mb-3 gap-1.5'>
			<FieldLabel className='text-label'>{label}</FieldLabel>
			{children}
			{hint ? <FieldDescription className='text-label'>{hint}</FieldDescription> : null}
		</ShadcnField>
	)
}
