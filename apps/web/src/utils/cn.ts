import { type ClassValue, clsx, createCn } from 'cnfast'

/**
 * The app's type scale is custom `--text-*` tokens, which tailwind-merge cannot
 * tell apart from a text colour: without this, `cn('text-primary-foreground',
 * 'text-body')` drops the colour. Registering them as font sizes keeps both.
 */
const cn = createCn({
	extend: { classGroups: { 'font-size': ['text-meta', 'text-label', 'text-body', 'text-title', 'text-reading'] } },
})

export { cn, clsx, type ClassValue }
