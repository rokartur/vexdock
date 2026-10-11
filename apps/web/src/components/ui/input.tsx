import type { ComponentProps } from 'react'
import { Input as InputPrimitive } from '@base-ui/react/input'
import { cn } from 'cn'

// Focus answers with the border alone; text fields sit outside the focus outline policy in styles.css.
export const fieldClass =
	'rounded-control border border-border-strong bg-surface-muted/50 text-sm text-foreground transition-colors outline-none placeholder:text-muted focus:border-foreground not-disabled:not-aria-invalid:hover:border-muted disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-50 aria-invalid:border-danger'

export function Input({ className, ...props }: ComponentProps<'input'>) {
	return <InputPrimitive {...props} className={cn(fieldClass, 'h-control-md w-full px-2.5', className)} />
}
