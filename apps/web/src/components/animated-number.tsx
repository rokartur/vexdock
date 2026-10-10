import { useEffect } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { easeOut } from '@/lib/motion'

/** A reading that counts to its new value instead of jumping. */
export function AnimatedNumber({ value, format }: { value: number; format: (value: number) => string }) {
	const reduced = useReducedMotion()
	const motionValue = useMotionValue(value)
	const text = useTransform(motionValue, format)

	useEffect(() => {
		const controls = animate(motionValue, value, { duration: reduced ? 0 : 0.3, ease: easeOut })
		return () => controls.stop()
	}, [motionValue, value, reduced])

	return <motion.span>{text}</motion.span>
}
