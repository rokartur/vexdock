import { useLayoutEffect, useRef, useState } from 'react'
import { tween } from './tween'

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

export function RollingNumber({ text }: { text: string }) {
	const [last, setLast] = useState({ text, direction: 1 })
	if (last.text !== text) {
		setLast({ text, direction: numericValue(text) >= numericValue(last.text) ? 1 : -1 })
	}
	const chars = [...text]
	return (
		<span aria-hidden className='inline-flex items-start whitespace-nowrap tabular-nums select-none'>
			{chars.map((char, index) => {
				// Keyed from the right, so a new leading digit enters on the left and the rest keep their wheels.
				const key = chars.length - index
				const digit = '0123456789'.indexOf(char)
				if (digit === -1) {
					return (
						<span key={key} className='inline-block whitespace-pre'>
							{char}
						</span>
					)
				}
				return <DigitWheel key={key} digit={digit} direction={last.direction} />
			})}
		</span>
	)
}

// Turns the way the number moved: up rolls 9 into 0, down rolls 0 into 9; glyphs fade with their distance from the centre.
function DigitWheel({ digit, direction }: { digit: number; direction: number }) {
	const glyphs = useRef(new Map<number, HTMLSpanElement>())
	const wheel = useRef({ digit, position: digit })

	useLayoutEffect(() => {
		const state = wheel.current
		if (state.digit === digit) return
		const steps = direction < 0 ? -((state.digit - digit + 10) % 10) : (digit - state.digit + 10) % 10
		state.digit = digit
		const from = state.position
		const to = from + steps
		return tween(280, 'enter', progress => {
			state.position = from + (to - from) * progress
			for (const [glyph, element] of glyphs.current)
				Object.assign(element.style, glyphStyle(glyph, state.position))
		})
	}, [digit, direction])

	return (
		<span className='relative -my-[0.18em] inline-block overflow-clip [mask-image:linear-gradient(to_bottom,transparent,black_0.25em,black_calc(100%-0.25em),transparent)] py-[0.18em]'>
			<span className='invisible'>0</span>
			{DIGITS.map(glyph => (
				<span
					key={glyph}
					ref={element => {
						if (!element) return
						glyphs.current.set(glyph, element)
						return () => {
							glyphs.current.delete(glyph)
						}
					}}
					className='absolute inset-x-0 top-[0.18em] bottom-[0.18em] text-center'
					style={glyphStyle(glyph, digit)}
				>
					{glyph}
				</span>
			))}
		</span>
	)
}

function glyphStyle(glyph: number, position: number) {
	const offset = ((((glyph - position) % 10) + 15) % 10) - 5
	return { translate: `0 ${offset}em`, opacity: String(Math.max(0, 1 - 1.2 * Math.abs(offset))) }
}

function numericValue(text: string) {
	return Number(text.replaceAll(/[^\d.-]/g, '')) || 0
}
