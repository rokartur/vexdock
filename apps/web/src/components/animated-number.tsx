import { AnimatedCounter } from '@/components/arc/animated-counter'

/** A reading whose digits roll to its new value. `format` decides the unit, so its digits are what turns. */
export function AnimatedNumber({ value, format }: { value: number; format: (value: number) => string }) {
	const text = format(value)
	const reading = readingOf(text)
	if (!reading) return <span>{text}</span>
	return <AnimatedCounter {...reading} className='text-[length:inherit] tracking-[inherit]' />
}

/** Splits `1.53 GB` into the number the counter rolls and the text around it. */
export function readingOf(text: string) {
	const groups = /^(?<prefix>\D*)(?<integer>\d+)(?:\.(?<fraction>\d+))?(?<suffix>.*)$/u.exec(text)?.groups
	if (!groups) return null
	const { prefix = '', integer, fraction = '', suffix = '' } = groups
	return { prefix, value: Number(`${integer}.${fraction}`), decimals: fraction.length, suffix }
}
