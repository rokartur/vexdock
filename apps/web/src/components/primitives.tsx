import type { ReactNode } from 'react'
import { IconRefresh } from '@tabler/icons-react'
import { Button as ShadcnButton } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field as ShadcnField, FieldDescription, FieldLabel } from '@/components/ui/field'
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

export function Button({
	children,
	onClick,
	variant = 'default',
	disabled,
	type = 'button',
	title,
}: {
	children: ReactNode
	onClick?: () => void
	variant?: ButtonVariant
	disabled?: boolean
	type?: 'button' | 'submit'
	title?: string
}) {
	return (
		<ShadcnButton
			type={type}
			title={title}
			onClick={onClick}
			disabled={disabled}
			size='sm'
			variant={buttonVariants[variant]}
			className={cn('h-7 px-2.5 text-xs', variant === 'ghost' && 'text-muted-foreground hover:text-foreground')}
		>
			{children}
		</ShadcnButton>
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
 */
export function Page({
	title,
	breadcrumb,
	actions,
	toolbar,
	children,
}: {
	title: ReactNode
	breadcrumb?: ReactNode
	actions?: ReactNode
	toolbar?: ReactNode
	children: ReactNode
}) {
	return (
		<>
			<header className='flex h-11 shrink-0 items-center justify-between gap-3 border-b px-5'>
				<div className='flex min-w-0 items-center gap-2'>
					{breadcrumb ? (
						<>
							{breadcrumb}
							<span className='text-muted-foreground'>/</span>
						</>
					) : null}
					<h1 className='truncate text-title font-medium text-foreground'>{title}</h1>
				</div>
				{actions ? <div className='flex shrink-0 items-center gap-2'>{actions}</div> : null}
			</header>
			{/* Bottom-aligned so a tab's own underline meets the row's border. */}
			{toolbar ? <div className='flex h-10 shrink-0 items-end gap-4 border-b px-5'>{toolbar}</div> : null}
			<div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>{children}</div>
		</>
	)
}

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
			<header className='mb-2 flex h-7 items-center justify-between gap-4'>
				<div className='flex items-baseline gap-3'>
					<h2 className='text-title font-medium'>{title}</h2>
					{description ? <span className='text-xs text-muted-foreground'>{description}</span> : null}
				</div>
				{actions ? <div className='flex items-center gap-2'>{actions}</div> : null}
			</header>
			{children}
		</section>
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
