import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/** The accent styles.css ships, in the hex a colour input speaks. */
export const DEFAULT_BRAND = '#e16540'

/** The only accents the panel offers. Lowercase hex, DEFAULT_BRAND included. */
export const BRAND_COLORS = [
	DEFAULT_BRAND,
	'#eb5757',
	'#f2994a',
	'#f2c94c',
	'#4cb782',
	'#26b5ce',
	'#5e6ad2',
	'#9b51e0',
	'#db6ba6',
	'#bec2c8',
]

/**
 * Paints the installation's accent onto `<html>`. The stylesheet derives
 * --chart-1 from --brand, so this one property is the whole override; an empty
 * setting removes it and the shipped orange comes back.
 */
export function useBrandColor() {
	const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
	const brand = settings.data?.brand_color ?? ''

	useEffect(() => {
		const { style } = document.documentElement
		if (brand === '') style.removeProperty('--brand')
		else style.setProperty('--brand', brand)
	}, [brand])
}
