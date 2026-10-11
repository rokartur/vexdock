import type { ComponentProps, MouseEvent, ReactElement } from 'react'
import { useRender } from '@base-ui/react/use-render'
import { IconDots } from '@tabler/icons-react'
import { cn } from 'cn'

// `not-disabled:` rather than `enabled:` so a rendered link, which has no :enabled state, still answers hover.
// A disabled outlined button keeps its shape and fades only its label, so it still reads as a button that is off.
const variants = {
	primary:
		'border-foreground bg-foreground text-background not-disabled:hover:opacity-91 not-disabled:hover:shadow-resting disabled:opacity-52',
	secondary:
		'border-border bg-surface-muted/50 text-foreground not-disabled:hover:bg-surface-muted disabled:bg-surface-muted disabled:text-muted',
	ghost: 'text-secondary not-disabled:hover:bg-surface-muted not-disabled:hover:text-foreground aria-pressed:bg-surface-muted aria-pressed:text-foreground disabled:text-muted',
	danger: 'border-border bg-surface-muted/50 text-danger not-disabled:hover:border-danger not-disabled:hover:bg-surface-muted disabled:bg-surface-muted disabled:text-danger/55',
} satisfies Record<string, string>

const sizes = {
	sm: 'h-control-sm px-2.5',
	md: 'h-control-md px-2.5',
} satisfies Record<string, string>

export type ButtonVariant = keyof typeof variants
export type ButtonSize = keyof typeof sizes

export type ButtonProps = ComponentProps<'button'> & {
	variant?: ButtonVariant
	size?: ButtonSize
	loading?: boolean
	/** Square, for a lone icon. */
	icon?: boolean
	/** Renders this element (a router link) styled as the button instead of a <button>. */
	render?: ReactElement
}

export function Button({
	variant = 'primary',
	size = 'md',
	loading = false,
	icon = false,
	render,
	className,
	children,
	onClick,
	...props
}: ButtonProps) {
	// A trigger that anchors a menu, popover or select answers with color, not scale: the layer positions against it.
	const popup = props['aria-haspopup']
	const anchorsPopup = (popup !== undefined && popup !== false && popup !== 'false') || props.role === 'combobox'

	return useRender({
		defaultTagName: 'button',
		render,
		props: {
			...props,
			className: cn(
				'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-transparent text-sm font-medium whitespace-nowrap no-underline select-none disabled:cursor-not-allowed aria-busy:cursor-progress [&_svg]:size-4 [&_svg]:shrink-0',
				anchorsPopup ? 'transition-colors' : 'press',
				variants[variant],
				sizes[size],
				icon && 'aspect-square px-0',
				className,
			),
			// Loading keeps the button focusable (disabled would drop keyboard focus mid-action) and swallows presses.
			'aria-busy': loading || undefined,
			'aria-disabled': loading || props['aria-disabled'] || undefined,
			onClick: loading ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault() : onClick,
			children: (
				<>
					{loading ? (
						// A static glyph, not a spinner: a looping animation repaints every frame on high-refresh displays.
						<span aria-hidden className='absolute inset-0 grid place-items-center'>
							<IconDots />
						</span>
					) : null}
					<span className={cn('inline-flex items-center gap-1.5', loading && 'invisible')}>{children}</span>
				</>
			),
		},
	})
}
