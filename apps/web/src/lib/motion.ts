export const motionTokens = {
	duration: { instant: 0.085, fast: 0.11, exit: 0.125, standard: 0.17, considered: 0.34 },
	ease: {
		enter: [0.16, 1, 0.3, 1],
		exit: [0.7, 0, 0.84, 0],
		standard: [0.22, 1, 0.36, 1],
		inOut: [0.65, 0, 0.35, 1],
	},
	spring: {
		responsive: { type: 'spring', stiffness: 1060, damping: 54 },
		gentle: { type: 'spring', stiffness: 690, damping: 49 },
		snappy: { type: 'spring', visualDuration: 0.18, bounce: 0.12 },
		smooth: { type: 'spring', visualDuration: 0.28, bounce: 0 },
		morph: { type: 'spring', visualDuration: 0.29, bounce: 0.16 },
	},
	stagger: { char: 0.011, word: 0.028, line: 0.055, item: 0.025 },
	blur: { subtle: 2, soft: 4, text: 8 },
} as const
