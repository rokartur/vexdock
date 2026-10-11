/** A reading whose digits roll to its new value. `format` decides the unit, so its digits are what turns. */
export function AnimatedNumber({ value, format }: { value: number; format: (value: number) => string }) {
	const text = format(value)
	const reading = readingOf(text)
	if (!reading) return <span>{text}</span>
	return (
		<span className='relative inline-flex leading-none'>
			<span className='sr-only'>{text}</span>
			<span aria-hidden className='inline-flex whitespace-pre select-none'>
				{reading.prefix}
				{partsOf(reading.integer, reading.fraction).map(part =>
					'text' in part ? (
						<span key={part.key}>{part.text}</span>
					) : (
						<Wheel key={part.key} digit={part.digit} />
					),
				)}
				{reading.suffix}
			</span>
		</span>
	)
}

/** All ten digits stacked in a one-digit window; the column slides to the one showing. */
function Wheel({ digit }: { digit: number }) {
	return (
		<span className='inline-block h-[1em] overflow-hidden'>
			<span
				className='flex flex-col transition-[translate] duration-480 ease-enter motion-reduce:transition-none'
				style={{ translate: `0 -${digit}em` }}
			>
				{DIGITS.map(item => (
					<span key={item} className='h-[1em]'>
						{item}
					</span>
				))}
			</span>
		</span>
	)
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

/** Keys every digit by its place value, so 999 → 1,000 keeps the ones column the ones column. */
function partsOf(integer: string, fraction: string) {
	const integers = [...integer].map((char, index) => ({ key: `i${integer.length - 1 - index}`, digit: Number(char) }))
	if (!fraction) return integers
	const fractions = [...fraction].map((char, index) => ({ key: `f${index}`, digit: Number(char) }))
	return [...integers, { key: 'd', text: '.' }, ...fractions]
}

/** Splits `1.53 GB` into the digits that roll and the text around them. */
export function readingOf(text: string) {
	const groups = /^(?<prefix>\D*)(?<integer>\d+)(?:\.(?<fraction>\d+))?(?<suffix>.*)$/u.exec(text)?.groups
	if (!groups) return null
	const { prefix = '', integer = '', fraction = '', suffix = '' } = groups
	return { prefix, integer, fraction, suffix }
}
