import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/utils/cn'

const buttonVariants = cva(
	// The press is datafa.st's: pressing scales the button to 0.95 and releasing
	// pops it past rest (animate-btn-pop restarts when :active removes it). Menu
	// triggers are exempt so an anchored popup does not jitter with its anchor.
	"group/button inline-flex shrink-0 animate-btn-pop items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:scale-[0.95] active:not-aria-[haspopup]:animate-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 motion-reduce:animate-none motion-reduce:active:scale-100 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			// datafa.st's variants: solid fills darken on hover by mixing in 10%
			// black instead of fading opacity, and the error button is solid with
			// black text. No shadows; the fill and the border carry the button.
			variant: {
				default:
					'bg-primary text-primary-foreground hover:bg-[color-mix(in_oklab,var(--color-primary)_90%,#000)]',
				outline:
					'border-border bg-card hover:bg-[color-mix(in_oklab,var(--color-card)_90%,#000)] hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
				secondary:
					'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklab,var(--color-secondary)_90%,#000)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
				ghost: 'hover:bg-foreground/20 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
				destructive:
					'bg-destructive text-black hover:bg-[color-mix(in_oklab,var(--color-destructive)_90%,#000)] focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
				link: 'text-primary underline-offset-4 hover:underline',
			},
			size: {
				default: 'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				icon: 'size-8',
				'icon-xs':
					"size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
				'icon-sm': 'size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg',
				'icon-lg': 'size-9',
			},
		},
		defaultVariants: {
			variant: 'default',
			size: 'default',
		},
	},
)

function Button({
	className,
	variant = 'default',
	size = 'default',
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive data-slot='button' className={cn(buttonVariants({ variant, size, className }))} {...props} />
	)
}

export { Button, buttonVariants }
