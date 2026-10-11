import type { ComponentProps } from 'react'
import { cn } from 'cn'
import { fieldClass } from './input'

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
	return <textarea {...props} className={cn(fieldClass, 'min-h-16 w-full resize-y px-2.5 py-2', className)} />
}
