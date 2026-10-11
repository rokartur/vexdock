import { useEffect, useRef, useState } from 'react'
import { IconAlertCircle, IconCheck, IconCopy } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from './button'
import type { ButtonVariant } from './button'

const FEEDBACK_MS = 1900

const icons = [
	{ state: 'idle', icon: IconCopy },
	{ state: 'copied', icon: IconCheck },
	{ state: 'error', icon: IconAlertCircle },
] as const

/** Arc's copy-button: the icon and label answer Copied or Failed, then fall back to the label. `onError` runs when the
 * clipboard refuses, e.g. outside a secure context, where navigator.clipboard is undefined. */
export function CopyButton({
	value,
	label = 'Copy',
	variant = 'secondary',
	disabled,
	onError,
}: {
	value: string
	label?: string
	variant?: ButtonVariant
	disabled?: boolean
	onError?: () => void
}) {
	const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
	const timeout = useRef(0)
	useEffect(() => () => clearTimeout(timeout.current), [])

	const copy = async () => {
		clearTimeout(timeout.current)
		try {
			await navigator.clipboard.writeText(value)
			setState('copied')
		} catch {
			setState('error')
			onError?.()
		}
		timeout.current = window.setTimeout(() => setState('idle'), FEEDBACK_MS)
	}

	const feedback = {
		idle: { text: label, announce: '' },
		copied: { text: 'Copied', announce: `${label}: Copied` },
		error: { text: 'Failed', announce: `${label}: Could not copy` },
	}[state]
	return (
		<>
			<Button variant={variant} disabled={disabled} onClick={copy}>
				{/* The icon swap recipe: all three share one grid cell and the current one cross-fades in. */}
				<span aria-hidden className='grid'>
					{icons.map(({ state: shownIn, icon: Icon }) => (
						<Icon
							key={shownIn}
							className={cn(
								'col-start-1 row-start-1 transition-[opacity,scale,filter] duration-240 ease-standard',
								state === shownIn ? 'opacity-100' : 'scale-25 opacity-0 blur-[4px]',
							)}
						/>
					))}
				</span>
				{feedback.text}
			</Button>
			<span className='sr-only' role='status' aria-live='polite'>
				{feedback.announce}
			</span>
		</>
	)
}
