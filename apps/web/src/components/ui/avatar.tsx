import { Avatar as AvatarPrimitive } from '@base-ui/react/avatar'
import { cn } from 'cn'

const graphemes = new Intl.Segmenter()

/** Initials of the first two words, by grapheme, so a name starting with an emoji or an accent stays whole. */
export function Avatar({ name, className }: { name: string; className?: string }) {
	const initials = name
		.trim()
		.split(/\s+/u)
		.slice(0, 2)
		.map(part => graphemes.segment(part)[Symbol.iterator]().next().value?.segment.toUpperCase() ?? '')
		.join('')
	return (
		<AvatarPrimitive.Root
			role='img'
			aria-label={name}
			className={cn(
				'inline-grid size-6 shrink-0 place-items-center rounded-[calc(var(--radius-control)-4px)] border bg-surface-muted text-[10px] font-medium text-foreground',
				className,
			)}
		>
			<AvatarPrimitive.Fallback aria-hidden>{initials}</AvatarPrimitive.Fallback>
		</AvatarPrimitive.Root>
	)
}
