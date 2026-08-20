import { type ComponentProps, Fragment, type KeyboardEvent, type ReactNode } from 'react'
import { IconRefresh } from '@tabler/icons-react'
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
			className={cn('h-7 px-2.5 text-xs', variant === 'ghost' && 'text-muted-foreground hover:text-foreground')}
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
			className='flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50'
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
	children,
}: {
	labels?: Record<string, ReactNode>
	actions?: ReactNode
	toolbar?: ReactNode
	children: ReactNode
}) {
	const router = useRouter()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const trail = trailOf(pathname, Object.keys(router.routesByPath)).filter(
		({ segment }) => labels?.[segment] !== null,
	)

	return (
		<>
			<header className='flex h-11 shrink-0 items-center justify-between gap-3 border-b px-5'>
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
			{/* Bottom-aligned so a tab's own underline meets the row's border. */}
			{toolbar ? <div className='flex h-10 shrink-0 items-end gap-4 border-b px-5'>{toolbar}</div> : null}
			<div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>{children}</div>
		</>
	)
}

/**
 * Sub-navigation for a Page's `toolbar`. A tab links to `base + suffix`; the
 * empty suffix is the layout's index route and only matches the base itself.
 */
export function Tabs({ base, tabs }: { base: string; tabs: { suffix: string; label: string }[] }) {
	const pathname = useRouterState({ select: state => state.location.pathname })

	return (
		<>
			{tabs.map(tab => {
				const to = base + tab.suffix
				const active =
					tab.suffix === '' ? pathname === base || pathname === `${base}/` : pathname.startsWith(to)
				return (
					<Link
						key={tab.label}
						to={to}
						className={cn(
							'-mb-px border-b px-0.5 pb-1.5 text-body',
							active
								? 'border-foreground text-foreground'
								: 'border-transparent text-muted-foreground hover:text-foreground',
						)}
					>
						{tab.label}
					</Link>
				)
			})}
		</>
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
}: {
	title: string
	actions?: ReactNode
	children: ReactNode
	description?: string
	onSave?: () => void
}) {
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (!onSave || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
		event.preventDefault()
		onSave()
	}

	return (
		<section className='mb-7' onKeyDown={onKeyDown}>
			<header className='mb-2 flex h-7 items-center justify-between gap-4'>
				<div className='flex items-baseline gap-3'>
					<h2 className='text-meta tracking-wider text-muted-foreground uppercase'>{title}</h2>
					{description ? <span className='text-meta text-muted-foreground/70'>{description}</span> : null}
				</div>
				{actions ? <div className='flex items-center gap-2'>{actions}</div> : null}
			</header>
			{children}
		</section>
	)
}

/**
 * A row of readings sharing hairlines, the way the panel shows any set of
 * numbers: no gaps, no per-card chrome, one border around the whole block.
 * Children supply their own padding and must not draw their own border.
 */
export function Cells({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				'grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-px overflow-hidden rounded-lg border bg-border [&>*]:bg-background',
				className,
			)}
		>
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
				'grid grid-cols-[max-content_1fr] gap-x-6 rounded-lg border px-3 py-0.5 text-body [&>*:nth-child(-n+2)]:border-t-0',
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<ShadcnField className='mb-3 gap-1'>
			<FieldLabel className='text-label tracking-wide text-muted-foreground uppercase'>{label}</FieldLabel>
			{children}
			{hint ? <FieldDescription className='text-label'>{hint}</FieldDescription> : null}
		</ShadcnField>
	)
}
