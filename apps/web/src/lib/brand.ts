import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/** The accent styles.css ships, in the hex a colour input speaks. */
export const DEFAULT_BRAND = '#e16540'

/**
 * Paints the installation's accent onto `<html>`. The stylesheet derives
 * --primary, --sidebar-primary, --chart-1 and the primary button's shadow from
 * --brand, so this one property is the whole override; an empty setting removes
 * it and the shipped orange comes back.
 */
export function useBrandColor() {
	const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
	const brand = settings.data?.brand_color ?? ''

	useEffect(() => {
		const { style } = document.documentElement
		if (brand === '') {
			style.removeProperty('--brand')
			style.removeProperty('--primary-foreground')
			return
		}
		style.setProperty('--brand', brand)
		// A pale accent needs dark text on it; the stylesheet's white is only
		// right for the orange it ships with.
		style.setProperty('--primary-foreground', readableOn(brand))
	}, [brand])
}

/**
 * Black or white, whichever the WCAG relative luminance of the accent asks for.
 * 0.5 is the usual threshold and lands on the same side as a contrast-ratio
 * comparison for every colour a picker can produce.
 */
export function readableOn(hex: string) {
	const channels = [1, 3, 5].map(offset => {
		const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
		return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
	})
	const [red = 0, green = 0, blue = 0] = channels
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.5 ? '#000000' : '#ffffff'
}
