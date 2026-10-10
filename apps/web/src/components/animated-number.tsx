import { useEffect } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'

/** A reading that counts to its new value instead of jumping. */
export function AnimatedNumber({ value, format }: { value: number; format: (value: number) => string }) {
	const reduced = useReducedMotion()
	const motionValue = useMotionValue(value)
	const text = useTransform(motionValue, format)

	useEffect(() => {
		// MotionConfig does not reach a bare animate(), so reduced motion is checked here. The curve is --ease-out.
		const controls = animate(motionValue, value, { duration: reduced ? 0 : 0.3, ease: [0.23, 1, 0.32, 1] })
		return () => controls.stop()
	}, [motionValue, value, reduced])

	return <motion.span>{text}</motion.span>
}
