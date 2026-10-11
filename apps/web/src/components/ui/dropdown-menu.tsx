import { Fragment } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'

export type DropdownItem = {
	label: string
	onSelect?: () => void
	/** Makes the item a router link. */
	href?: string
	disabled?: boolean
	icon?: ReactNode
	destructive?: boolean
	separatorBefore?: boolean
}

export function DropdownMenu({
	items,
	trigger,
	side = 'bottom',
	align = 'end',
	menuClassName,
}: {
	items: DropdownItem[]
	/** Any button element (an icon button, a primary action) that opens the menu. */
	trigger: ReactElement
	side?: 'top' | 'bottom'
	align?: 'start' | 'end'
	/** Extra classes for the menu panel, such as a fixed width. */
	menuClassName?: string
}) {
	return (
		<MenuPrimitive.Root>
			<MenuPrimitive.Trigger render={trigger} />
			<MenuPrimitive.Portal>
				<MenuPrimitive.Positioner
					className='z-60'
					side={side}
					sideOffset={6}
					align={align}
					collisionPadding={12}
				>
					<MenuPrimitive.Popup
						className={cn(
							'max-w-(--available-width) min-w-[min(12rem,var(--available-width))] popup rounded-panel border bg-surface-raised p-1 shadow-floating outline-none',
							menuClassName,
						)}
					>
						{items.map(item => {
							const className = cn(
								'flex min-h-8 cursor-pointer items-center gap-2 rounded-[calc(var(--radius-panel)-4px)] px-2 text-sm no-underline outline-none select-none data-disabled:cursor-default data-disabled:opacity-45',
								item.destructive
									? 'text-danger data-highlighted:bg-danger/10'
									: 'text-foreground data-highlighted:bg-surface-muted',
							)
							const body = (
								<>
									{item.icon ? (
										<span
											aria-hidden
											className={cn(
												'inline-flex [&_svg]:size-4',
												item.destructive ? 'text-danger' : 'text-secondary',
											)}
										>
											{item.icon}
										</span>
									) : null}
									{item.label}
								</>
							)
							return (
								<Fragment key={item.label}>
									{item.separatorBefore ? (
										<MenuPrimitive.Separator className='-mx-1 my-1 h-px bg-border-subtle' />
									) : null}
									{item.href === undefined ? (
										<MenuPrimitive.Item
											className={className}
											disabled={item.disabled}
											onClick={() => item.onSelect?.()}
										>
											{body}
										</MenuPrimitive.Item>
									) : (
										<MenuPrimitive.LinkItem
											className={className}
											closeOnClick
											render={<Link to={item.href} />}
										>
											{body}
										</MenuPrimitive.LinkItem>
									)}
								</Fragment>
							)
						})}
					</MenuPrimitive.Popup>
				</MenuPrimitive.Positioner>
			</MenuPrimitive.Portal>
		</MenuPrimitive.Root>
	)
}
