import type { CSSProperties, PointerEvent, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { cn } from 'cn'
import type { MotionStyle, MotionValue } from 'motion/react'
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react'
import { motionTokens } from '../lib/motion'
import { Logo } from './logo'

// Arc's login-centered block at fullScreen, cut to its frame: the ring field drifting under the pointer, the
// brand row, one card and the footer. Its steps (passkey, email code, SSO) have no backend here.
const rings: { r: number; major: boolean; style: CSSProperties & Record<'--k', number> }[] = Array.from(
	{ length: 14 },
	(_, index) => ({ r: 224 + index * 60, major: index % 3 === 2, style: { '--k': 1 + index * 0.34 } }),
)

const ringClass =
	'fill-none stroke-border-subtle stroke-1 [transform:translate(calc(var(--dx,0px)*var(--k,1)),calc(var(--dy,0px)*var(--k,1)))] motion-reduce:[transform:none]'

/** The screen outside the shell: sign in, first setup, OAuth consent. `aside` sits right of the brand. */
export function AuthScreen({
	label,
	title,
	lead,
	aside,
	footer,
	children,
}: {
	label: string
	title: ReactNode
	lead?: ReactNode
	aside?: ReactNode
	footer?: ReactNode
	children: ReactNode
}) {
	const reduce = useReducedMotion() ?? false
	const drift = useDrift(reduce)
	return (
		<div
			className='@container relative isolate grid min-h-dvh w-full min-w-0 grid-rows-[64px_minmax(0,1fr)_64px] overflow-hidden bg-background font-sans text-foreground'
			onPointerMove={drift.handlePointerMove}
			onPointerLeave={drift.handlePointerLeave}
		>
			<motion.div
				className='pointer-events-none absolute inset-0 -z-1 [mask-image:radial-gradient(ellipse_72%_78%_at_50%_50%,black_38%,transparent_100%)]'
				style={drift.style}
				aria-hidden='true'
			>
				<svg className='absolute inset-0 size-full overflow-visible'>
					<svg x='50%' y='50%' overflow='visible'>
						<line className={ringClass} x1='-2400' x2='2400' y1='0' y2='0' />
						<line className={ringClass} x1='0' x2='0' y1='-2400' y2='2400' />
						{rings.map(ring => (
							<circle
								key={ring.r}
								className={cn(ringClass, ring.major && 'stroke-border')}
								r={ring.r}
								cx='0'
								cy='0'
								style={ring.style}
							/>
						))}
					</svg>
				</svg>
			</motion.div>

			<header className='flex min-w-0 items-center justify-between gap-3 px-4 @max-[520px]:px-3'>
				<span className='inline-flex items-center gap-1.5 text-base/none font-medium'>
					<Logo className='size-5' />
					vexdock
				</span>
				{aside}
			</header>

			<main
				aria-label={label}
				className='grid min-w-0 place-items-center px-3 py-4 @max-[520px]:p-3 @max-[400px]:px-2.5'
			>
				<div className='w-[min(100%,420px)] min-w-0 overflow-hidden rounded-surface border border-border bg-surface shadow-resting'>
					<div className='grid min-w-0 enter-children p-6 @max-[520px]:p-4'>
						<div className='mb-4 grid gap-1.5'>
							<h1 className='m-0 font-display text-3xl font-normal text-balance @max-[400px]:font-sans @max-[400px]:text-2xl @max-[400px]:leading-(--text-3xl--line-height) @max-[400px]:tracking-(--text-3xl--letter-spacing)'>
								{title}
							</h1>
							{lead ? <p className='m-0 text-sm text-pretty text-secondary'>{lead}</p> : null}
						</div>
						{children}
					</div>
				</div>
			</main>

			<footer className='flex min-w-0 items-center justify-between gap-3 px-4 text-xs text-muted @max-[520px]:px-3'>
				{footer}
			</footer>
		</div>
	)
}

function useDrift(reduce: boolean) {
	const pointerX = useMotionValue(0)
	const pointerY = useMotionValue(0)
	const x = useSpring(pointerX, motionTokens.spring.drift)
	const y = useSpring(pointerY, motionTokens.spring.drift)
	const dx = useTransform(x, value => `${value.toFixed(2)}px`)
	const dy = useTransform(y, value => `${value.toFixed(2)}px`)
	const canHover = useRef(false)
	useEffect(() => {
		const query = window.matchMedia('(hover: hover) and (pointer: fine)')
		const sync = () => {
			canHover.current = query.matches
		}
		sync()
		query.addEventListener('change', sync)
		return () => query.removeEventListener('change', sync)
	}, [])
	const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
		if (reduce || !canHover.current || event.pointerType !== 'mouse') return
		const box = event.currentTarget.getBoundingClientRect()
		pointerX.set(((event.clientX - box.left) / box.width - 0.5) * -2)
		pointerY.set(((event.clientY - box.top) / box.height - 0.5) * -2)
	}
	const handlePointerLeave = () => {
		pointerX.set(0)
		pointerY.set(0)
	}
	const style: MotionStyle & Record<`--${string}`, MotionValue<string>> = { '--dx': dx, '--dy': dy }
	return { style, handlePointerMove, handlePointerLeave }
}
