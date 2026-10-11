'use client'

import { useEffect, useRef, useState } from 'react'
import { IconAlertCircle, IconCheck, IconCopy } from '@tabler/icons-react'
import Button, { type ButtonVariant } from './button'

type CopyState = 'idle' | 'copied' | 'error'

const FEEDBACK_MS = 1900

/** Arc's CopyButton: the icon and label answer Copied or Failed, then fall back to the label. `onError` runs when the
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
	const [state, setState] = useState<CopyState>('idle')
	const timeout = useRef<ReturnType<typeof setTimeout>>(undefined)
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
		timeout.current = setTimeout(() => setState('idle'), FEEDBACK_MS)
	}

	const Icon = state === 'copied' ? IconCheck : state === 'error' ? IconAlertCircle : IconCopy
	return (
		<>
			<Button variant={variant} size='md' disabled={disabled} onClick={copy}>
				<Icon />
				{state === 'copied' ? 'Copied' : state === 'error' ? 'Failed' : label}
			</Button>
			<span className='sr-only' role='status' aria-live='polite'>
				{state === 'copied' ? `${label}: Copied` : state === 'error' ? `${label}: Could not copy` : ''}
			</span>
		</>
	)
}
