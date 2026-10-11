import { useState } from 'react'
import type { ComponentProps } from 'react'
import { IconEye, IconEyeOff } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from './button'

/** Arc's password-field without its own label (the dashboard's Field names it): the input and a show/hide toggle. */
export function PasswordField({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
	const [visible, setVisible] = useState(false)
	const Eye = visible ? IconEyeOff : IconEye
	return (
		<div
			className={cn(
				'flex h-control-md w-full items-center gap-1 rounded-control border border-border-strong bg-surface-muted/50 pr-0.5 pl-2.5 transition-colors focus-within:border-foreground has-aria-invalid:border-danger has-[input:disabled]:bg-surface-muted has-[input:disabled]:opacity-50 has-[input:enabled:not([aria-invalid=true])]:hover:border-muted',
				className,
			)}
		>
			<input
				{...props}
				type={visible ? 'text' : 'password'}
				className='h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed'
			/>
			<Button
				variant='ghost'
				size='sm'
				icon
				onClick={() => setVisible(current => !current)}
				aria-label={visible ? 'Hide password' : 'Show password'}
				aria-pressed={visible}
				disabled={props.disabled}
			>
				<Eye />
			</Button>
		</div>
	)
}
