import { RollingNumber } from './ui/rolling-number'

/** A reading whose digits roll to its new value. `format` decides the unit, so its digits are what turns. */
export function AnimatedNumber({ value, format }: { value: number; format: (value: number) => string }) {
	const text = format(value)
	return (
		<span className='relative inline-flex leading-none'>
			<span className='sr-only'>{text}</span>
			<RollingNumber text={text} />
		</span>
	)
}
