import { createCn } from 'cn/config'

/**
 * The app's type scale is custom `--text-*` tokens, which tailwind-merge cannot
 * tell apart from a text color: without this, `cn('text-primary-foreground',
 * 'text-body')` drops the color. Registering them as font sizes keeps both.
 */
export const cn = createCn({
	extend: { classGroups: { 'font-size': ['text-meta', 'text-label', 'text-body', 'text-title', 'text-reading'] } },
})
