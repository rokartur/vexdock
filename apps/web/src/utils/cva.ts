import { clsx, type ClassValue } from 'cnfast'

// ============================================================================
// Types
// ============================================================================

type ClassProp =
	| { class: ClassValue; className?: never }
	| { class?: never; className: ClassValue }
	| { class?: never; className?: never }

type OmitUndefined<T> = T extends undefined ? never : T

type StringToBoolean<T> = T extends 'true' | 'false' ? boolean : T

type ConfigSchema = Record<string, Record<string, ClassValue>>

type ConfigVariants<T extends ConfigSchema> = {
	[Variant in keyof T]?: StringToBoolean<keyof T[Variant]> | null | undefined
}

type ConfigVariantsMulti<T extends ConfigSchema> = {
	[Variant in keyof T]?: StringToBoolean<keyof T[Variant]> | StringToBoolean<keyof T[Variant]>[] | undefined
}

type Config<T> = T extends ConfigSchema
	? {
			variants?: T
			defaultVariants?: ConfigVariants<T>
			compoundVariants?: (T extends ConfigSchema
				? (ConfigVariants<T> | ConfigVariantsMulti<T>) & ClassProp
				: ClassProp)[]
		}
	: never

type Props<T> = T extends ConfigSchema ? ConfigVariants<T> & ClassProp : ClassProp

// ============================================================================
// Exports
// ============================================================================

/**
 * Extract variant props from a cva component
 *
 * @example
 * ```ts
 * const button = cva('btn', { variants: { size: { sm: 'btn-sm' } } })
 * type ButtonProps = VariantProps<typeof button>
 * // { size?: 'sm' | null | undefined }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VariantProps<Component extends (...args: any) => any> = Omit<
	OmitUndefined<Parameters<Component>[0]>,
	'class' | 'className'
>

export type CxOptions = Parameters<typeof clsx>
export type CxReturn = ReturnType<typeof clsx>

/**
 * Concatenates class names (alias for clsx)
 */
export const cx: typeof clsx = clsx

// ============================================================================
// Implementation
// ============================================================================

const falsyToString = (value: unknown): string | undefined =>
	typeof value === 'boolean' ? `${value}` : value === 0 ? '0' : (value as string | undefined)

/**
 * Class Variance Authority - create variant-based class name functions
 *
 * @example
 * ```ts
 * const button = cva('btn', {
 *   variants: {
 *     intent: {
 *       primary: 'bg-blue-500 text-white',
 *       secondary: 'bg-gray-200 text-gray-800',
 *     },
 *     size: {
 *       sm: 'text-sm py-1 px-2',
 *       md: 'text-base py-2 px-4',
 *     },
 *   },
 *   compoundVariants: [
 *     { intent: 'primary', size: 'md', class: 'uppercase' },
 *   ],
 *   defaultVariants: {
 *     intent: 'primary',
 *     size: 'md',
 *   },
 * })
 *
 * button() // => 'btn bg-blue-500 text-white text-base py-2 px-4 uppercase'
 * button({ intent: 'secondary', size: 'sm' }) // => 'btn bg-gray-200 text-gray-800 text-sm py-1 px-2'
 * ```
 */
export const cva =
	<T>(base?: ClassValue, config?: Config<T>) =>
	(props?: Props<T>): string => {
		if (config?.variants == null) {
			return cx(base, (props as ClassProp | undefined)?.class, (props as ClassProp | undefined)?.className)
		}

		const { variants, defaultVariants } = config

		// Get class names for each variant
		const variantClassNames = Object.keys(variants).map(variant => {
			const variantProp = (props as Record<string, unknown> | undefined)?.[variant]
			const defaultVariantProp = (defaultVariants as Record<string, unknown> | undefined)?.[variant]

			// null explicitly removes the variant
			if (variantProp === null) return null

			const variantKey = falsyToString(variantProp) || falsyToString(defaultVariantProp)
			if (!variantKey) return null

			const variantValues = (variants as Record<string, Record<string, ClassValue>>)[variant]
			return variantValues?.[variantKey] ?? null
		})

		// Filter out undefined props for compound variant matching
		const propsWithoutUndefined =
			props &&
			Object.entries(props as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, value]) => {
				if (value === undefined) return acc
				acc[key] = value
				return acc
			}, {})

		// Get compound variant class names
		const compoundVariantClassNames = config.compoundVariants?.reduce<ClassValue[]>((acc, compoundVariant) => {
			const { class: cvClass, className: cvClassName, ...compoundVariantOptions } = compoundVariant

			const matches = Object.entries(compoundVariantOptions).every(([key, value]) => {
				const mergedProps = { ...defaultVariants, ...propsWithoutUndefined } as Record<string, unknown>

				if (Array.isArray(value)) {
					return value.includes(mergedProps[key])
				}

				return mergedProps[key] === value
			})

			if (matches) {
				return [...acc, cvClass, cvClassName]
			}

			return acc
		}, [])

		return cx(
			base,
			variantClassNames,
			compoundVariantClassNames,
			(props as ClassProp | undefined)?.class,
			(props as ClassProp | undefined)?.className,
		)
	}
