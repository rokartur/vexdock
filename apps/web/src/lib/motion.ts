import { flushSync } from 'react-dom'

export const motionTokens = {
	duration: { instant: 0.085, fast: 0.11, exit: 0.125, standard: 0.17, considered: 0.34 },
	ease: {
		enter: [0.16, 1, 0.3, 1],
		exit: [0.7, 0, 0.84, 0],
		standard: [0.22, 1, 0.36, 1],
		inOut: [0.65, 0, 0.35, 1],
	},
	spring: {
		snappy: { type: 'spring', visualDuration: 0.18, bounce: 0 },
		smooth: { type: 'spring', visualDuration: 0.28, bounce: 0 },
		morph: { type: 'spring', visualDuration: 0.29, bounce: 0 },
		// Arc's slow 0.63 s step; the auth backdrop trails the pointer with it.
		drift: { type: 'spring', visualDuration: 0.63, bounce: 0 },
	},
	stagger: { char: 0.011, word: 0.028, line: 0.055, item: 0.025 },
	blur: { subtle: 2, soft: 4, text: 8 },
} as const

/** The Morph recipe (styles.css): the `[data-morph-from]` text inside `source` carries over into the `[data-morph]`
 * element that `update` renders under the same `--morph` name. */
export function morph(source: HTMLElement, name: string, update: () => unknown) {
	const from = source.querySelector<HTMLElement>('[data-morph-from]')
	if (!from || !CSS.supports('selector(:active-view-transition-type(morph))')) {
		update()
		return
	}
	// Named only for this transition: a static name would repeat on every row.
	from.style.viewTransitionName = name
	document.startViewTransition({
		types: ['morph'],
		update: () => {
			from.style.viewTransitionName = ''
			// The target has to be in the DOM when the new state is captured; a returned promise is waited for.
			return flushSync(update)
		},
	})
}
