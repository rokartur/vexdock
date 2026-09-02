import { type ComponentProps, Fragment, type KeyboardEvent, type ReactNode } from 'react'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { IconCheck, IconChevronDown, IconRefresh } from '@tabler/icons-react'
import { Link, useRouter, useRouterState } from '@tanstack/react-router'
import { Button as ShadcnButton } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field as ShadcnField, FieldDescription, FieldLabel } from '@/components/ui/field'
import { labelOf, trailOf } from '@/lib/breadcrumb'
import { cn } from '@/utils/cn'

/**
 * The vocabulary every page speaks. Each one wraps a shadcn component so the
 * whole panel inherits one design system, while keeping the dense, flat layout
 * the dashboard needs.
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

// Only the intent is ours; everything else passes through, so a Button can be
// what a menu trigger renders as and still receive the handlers that needs.
export function Button({
	variant = 'default',
	type = 'button',
	...props
}: Omit<ComponentProps<typeof ShadcnButton>, 'variant' | 'size' | 'className'> & { variant?: ButtonVariant }) {
	return (
		<ShadcnButton
			type={type}
			size='sm'
			variant={buttonVariants[variant]}
			className={cn('h-8 px-3 text-xs', variant === 'ghost' && 'text-muted-foreground hover:text-foreground')}
			{...props}
		/>
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
	return (
		<button
			type='button'
			aria-label='Refresh'
			title='Refresh'
			onClick={onClick}
			disabled={busy}
			className='flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,scale] hover:bg-foreground/20 hover:text-foreground active:scale-[0.95] disabled:cursor-default disabled:opacity-50 motion-reduce:active:scale-100'
		>
			<IconRefresh className='size-4' />
		</button>
	)
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
			<header className='flex h-12 shrink-0 items-center justify-between gap-3 border-b px-6'>
				<div className='flex min-w-0 items-center gap-2'>
					{trail.map(({ segment, to, linkable }, index) => {
						const label = labels?.[segment]
						// A supplied label owns its own interaction: the pickers render a
						// button, and wrapping that in a link would navigate on the click
						// that opens the popover.
						return (
							<Fragment key={to}>
								{index > 0 ? <span className='text-muted-foreground'>/</span> : null}
								{linkable && label === undefined ? (
									<Link
										to={to}
										className='truncate text-body text-muted-foreground hover:text-foreground'
									>
										{labelOf(segment)}
									</Link>
								) : (
									<span
										className={cn(
											'flex min-w-0 items-center gap-2 truncate text-body',
											index === trail.length - 1
												? 'font-medium text-foreground'
												: 'text-muted-foreground',
										)}
									>
										{label ?? labelOf(segment)}
									</span>
								)}
							</Fragment>
						)
					})}
				</div>
				{actions ? <div className='flex shrink-0 items-center gap-2'>{actions}</div> : null}
			</header>
			{toolbar || filters ? (
				<div className='flex h-11 shrink-0 items-center gap-4 border-b px-6'>
					{toolbar}
					<div className='ml-auto flex items-center gap-2'>{filters}</div>
				</div>
			) : null}
			<div className='min-h-0 flex-1 overflow-y-auto px-6 py-5'>{children}</div>
		</>
	)
}

/**
 * The one switch shape in the app, datafa.st's dashboard tabs: a sunken strip
 * whose active item is a raised card-coloured pill. `Tabs` drives it off the
 * URL, `Segmented` off a value, and both belong in a Page's `toolbar`.
 */
const segmentStrip =
	'inline-flex h-8 shrink-0 items-center rounded-xl bg-sidebar/70 p-0.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]'

const segmentItem = (active: boolean) =>
	cn(
		'inline-flex h-full items-center rounded-lg px-2.5 text-body font-medium whitespace-nowrap transition-[color,background-color,scale] active:scale-[0.96] motion-reduce:active:scale-100',
		active ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground/60 hover:text-foreground',
	)

/**
 * Sub-navigation for a Page's `toolbar`. A tab links to `base + suffix`; the
 * empty suffix is the layout's index route and only matches the base itself.
 */
export function Tabs({ base, tabs }: { base: string; tabs: { suffix: string; label: string }[] }) {
	const pathname = useRouterState({ select: state => state.location.pathname })

	return (
		<nav className={segmentStrip}>
			{tabs.map(tab => {
				const to = base + tab.suffix
				const active =
					tab.suffix === '' ? pathname === base || pathname === `${base}/` : pathname.startsWith(to)
				return (
					<Link
						key={tab.label}
						to={to}
						aria-current={active ? 'page' : undefined}
						className={segmentItem(active)}
					>
						{tab.label}
					</Link>
				)
			})}
		</nav>
	)
}

/** The same strip, switching a value instead of the URL: ranges, filters, modes. */
export function Segmented<TValue extends string>({
	value,
	options,
	onChange,
}: {
	value: TValue
	options: { value: TValue; label: string }[]
	onChange: (value: TValue) => void
}) {
	return (
		<div className={segmentStrip}>
			{options.map(option => (
				<button
					key={option.value}
					type='button'
					aria-pressed={option.value === value}
					onClick={() => onChange(option.value)}
					className={segmentItem(option.value === value)}
				>
					{option.label}
				</button>
			))}
		</div>
	)
}

/**
 * `onSave` binds Cmd+S (macOS) / Ctrl+S to this section while the caret is
 * inside it, so a page with several sections saves the one being edited.
 */
export function Section({
	title,
	actions,
	children,
	description,
	onSave,
	className,
}: {
	title: string
	actions?: ReactNode
	children: ReactNode
	description?: string
	onSave?: () => void
	/** Layout only, e.g. letting a section fill the page for a full-height table. */
	className?: string
}) {
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (!onSave || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
		event.preventDefault()
		onSave()
	}

	return (
		<section className={cn('mb-10', className)} onKeyDown={onKeyDown}>
			<header className='mb-3 flex h-8 items-center justify-between gap-4'>
				<div className='flex items-baseline gap-3'>
					<h2 className='text-title font-bold'>{title}</h2>
					{description ? <span className='text-label text-muted-foreground'>{description}</span> : null}
				</div>
				{actions ? <div className='flex items-center gap-2'>{actions}</div> : null}
			</header>
			{children}
		</section>
	)
}

/**
 * A row of readings sharing hairlines: a card whose cells split it into equal
 * readings, one ring shadow around the whole block. Children supply their own
 * padding and must not draw their own border.
 */
export function Cells({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				'grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-px overflow-hidden rounded-xl bg-border shadow-card [&>*]:bg-card',
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
	value,
	hint,
	children,
}: {
	label: string
	/** Left out by a cell whose body is its content, e.g. a list of facts. */
	value?: ReactNode
	hint?: ReactNode
	children?: ReactNode
}) {
	return (
		<div className='px-3 py-2.5'>
			<div className='text-meta tracking-wide text-muted-foreground uppercase'>{label}</div>
			{value === undefined ? null : (
				<div className='mt-1 truncate text-reading font-bold tabular-nums'>{value}</div>
			)}
			{hint ? <div className='mt-0.5 truncate text-meta text-muted-foreground'>{hint}</div> : null}
			{children}
		</div>
	)
}

/**
 * A list of facts: label on the left, value on the right, one hairline per row.
 * The shape the panel uses wherever a set of attributes is read, not edited.
 *
 * The box owns the outer edge, so the first row drops the hairline every `Fact`
 * draws above itself.
 */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<dl
			className={cn(
				'grid grid-cols-[max-content_1fr] gap-x-6 rounded-xl bg-card px-3 py-0.5 text-body shadow-card [&>*:nth-child(-n+2)]:border-t-0',
				className,
			)}
		>
			{children}
		</dl>
	)
}

/** One row of a `Facts` list. The dt/dd pair are the grid's cells, so no wrapper. */
export function Fact({ label, value }: { label: string; value: ReactNode }) {
	return (
		<>
			<dt className='border-t py-1.5'>{label}</dt>
			<dd className='truncate border-t py-1.5 text-right font-mono text-muted-foreground'>{value}</dd>
		</>
	)
}

export function ErrorText({ error }: { error: unknown }) {
	if (!error) return null
	const message = error instanceof Error ? error.message : String(error)
	return (
		<p role='alert' className='py-2 text-xs text-destructive'>
			{message}
		</p>
	)
}

/**
 * The only checkbox shape in the app. Wrapping in a <label> is safe: base-ui's
 * Checkbox renders a visually hidden native input, so clicking the text toggles it.
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
		<label className={cn('flex items-center gap-1.5 text-body', muted && 'text-muted-foreground', className)}>
			<Checkbox checked={checked} disabled={disabled} onCheckedChange={onChange} />
			{label}
		</label>
	)
}

/**
 * The only picker shape in the app. The trigger wears the plain-input styling
 * from styles.css, so a Select and an <input> next to it are the same control.
 */
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
		<SelectPrimitive.Root
			items={options}
			value={value}
			onValueChange={next => {
				if (next !== null) onChange(next)
			}}
			required={required}
			disabled={disabled}
		>
			<SelectPrimitive.Trigger
				data-slot='select-trigger'
				aria-label={label}
				className={cn('flex cursor-pointer items-center justify-between gap-2 text-left', className)}
			>
				<SelectPrimitive.Value className='truncate' />
				<IconChevronDown className='size-3.5 shrink-0 text-muted-foreground' />
			</SelectPrimitive.Trigger>
			<SelectPrimitive.Portal>
				<SelectPrimitive.Positioner
					className='isolate z-50 outline-none'
					sideOffset={4}
					alignItemWithTrigger={false}
				>
					<SelectPrimitive.Popup className='max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none'>
						{options.map(option => (
							<SelectPrimitive.Item
								key={option.value}
								value={option.value}
								className='flex cursor-default items-center justify-between gap-3 rounded-md py-1 pr-1.5 pl-2 text-body outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground'
							>
								<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
								<SelectPrimitive.ItemIndicator>
									<IconCheck className='size-3.5' />
								</SelectPrimitive.ItemIndicator>
							</SelectPrimitive.Item>
						))}
					</SelectPrimitive.Popup>
				</SelectPrimitive.Positioner>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	)
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<ShadcnField className='mb-3 gap-1'>
			<FieldLabel className='text-label tracking-wide text-muted-foreground uppercase'>{label}</FieldLabel>
			{children}
			{hint ? <FieldDescription className='text-label'>{hint}</FieldDescription> : null}
		</ShadcnField>
	)
}
