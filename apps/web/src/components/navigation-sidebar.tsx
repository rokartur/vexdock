import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/utils/cn'

/** Width bounds of the navigation panel, in rem (219px / 329px / 252px). */
export const MIN_NAV_WIDTH_REM = 13.6875
export const MAX_NAV_WIDTH_REM = 20.5625
export const DEFAULT_NAV_WIDTH_REM = 15.75
/** Width of the collapsed navigation hit-target in px. */
export const NAV_COLLAPSED_WIDTH = 8
const WIDTH_KEY = 'navigation-leftBarWidth'

/**
 * Read during the first render rather than restored afterwards, so no reload
 * ever renders the default width and then corrects it. Safe because the rail
 * is client-only: the auth gate resolves a session before the shell mounts,
 * so this width is never part of the prerendered markup.
 */
function storedWidth() {
	if (typeof localStorage === 'undefined') return DEFAULT_NAV_WIDTH_REM
	const stored = Number(localStorage.getItem(WIDTH_KEY))
	return stored >= MIN_NAV_WIDTH_REM && stored <= MAX_NAV_WIDTH_REM ? stored : DEFAULT_NAV_WIDTH_REM
}

interface NavigationSidebarProps {
	children: ReactNode
	canHide?: boolean
	isHidden?: boolean
	showTemporary?: boolean
	onShowTemporaryChange?: (show: boolean) => void
}

/**
 * The shell's left rail: a fixed, resizable panel that can be hidden entirely
 * and slid back in by hovering the screen edge. Hidden state is owned by the
 * caller because the toggle lives in the navigation it renders.
 */
export function NavigationSidebar({
	children,
	canHide = false,
	isHidden = false,
	showTemporary = false,
	onShowTemporaryChange,
}: Readonly<NavigationSidebarProps>) {
	const [leftBarWidth, setLeftBarWidth] = useState(storedWidth)
	const [renderWidth, setRenderWidth] = useState(leftBarWidth)
	const [isResizing, setIsResizing] = useState(false)
	const navRef = useRef<HTMLDivElement>(null)
	const isResizingRef = useRef(false)
	const resizeStartXRef = useRef(0)
	const resizeStartWidthRef = useRef(0)
	const pendingWidthRef = useRef(leftBarWidth)
	const frameRef = useRef<number | null>(null)

	const sidebarIsHidden = canHide && isHidden
	const sidebarShownTemporary = canHide && showTemporary
	const navWidthPx = renderWidth * 16

	useEffect(() => {
		if (!isResizing) {
			setRenderWidth(leftBarWidth)
			pendingWidthRef.current = leftBarWidth
		}
	}, [isResizing, leftBarWidth])

	useEffect(
		() => () => {
			if (frameRef.current !== null) {
				window.cancelAnimationFrame(frameRef.current)
			}
		},
		[],
	)

	function handleMouseEnter() {
		if (sidebarIsHidden) {
			onShowTemporaryChange?.(true)
		}
	}

	function handleMouseLeave() {
		if (isResizingRef.current) return
		if (sidebarIsHidden) {
			onShowTemporaryChange?.(false)
		}
	}

	function startResize(startX: number) {
		if (sidebarIsHidden && !sidebarShownTemporary) return

		isResizingRef.current = true
		setIsResizing(true)
		resizeStartXRef.current = startX
		resizeStartWidthRef.current = renderWidth
		pendingWidthRef.current = renderWidth

		if (sidebarIsHidden) {
			onShowTemporaryChange?.(true)
		}

		const handleMouseMove = (event: MouseEvent) => {
			const newWidthRem = sidebarIsHidden
				? event.clientX / 16
				: resizeStartWidthRef.current + (event.clientX - resizeStartXRef.current) / 16
			pendingWidthRef.current = Math.min(MAX_NAV_WIDTH_REM, Math.max(MIN_NAV_WIDTH_REM, newWidthRem))
			if (frameRef.current !== null) return

			frameRef.current = window.requestAnimationFrame(() => {
				frameRef.current = null
				setRenderWidth(pendingWidthRef.current)
			})
		}

		const handleMouseUp = (event: MouseEvent) => {
			isResizingRef.current = false
			setIsResizing(false)
			document.removeEventListener('mousemove', handleMouseMove)
			document.removeEventListener('mouseup', handleMouseUp)
			document.body.style.cursor = ''
			document.body.style.userSelect = ''

			if (frameRef.current !== null) {
				window.cancelAnimationFrame(frameRef.current)
				frameRef.current = null
			}

			setRenderWidth(pendingWidthRef.current)
			setLeftBarWidth(pendingWidthRef.current)
			localStorage.setItem(WIDTH_KEY, String(pendingWidthRef.current))

			if (sidebarIsHidden) {
				const navBounds = navRef.current?.getBoundingClientRect()
				const pointerIsOverNav =
					navBounds !== undefined &&
					event.clientX >= navBounds.left &&
					event.clientX <= navBounds.right &&
					event.clientY >= navBounds.top &&
					event.clientY <= navBounds.bottom

				if (!pointerIsOverNav) {
					onShowTemporaryChange?.(false)
				}
			}
		}

		document.addEventListener('mousemove', handleMouseMove)
		document.addEventListener('mouseup', handleMouseUp)
		document.body.style.cursor = 'col-resize'
		document.body.style.userSelect = 'none'
	}

	return (
		<div className='relative'>
			{canHide && (
				<motion.div
					className={cn(
						'fixed inset-y-0 right-0 bg-sidebar',
						!sidebarShownTemporary && 'pointer-events-none',
					)}
					style={{ left: 0 }}
					animate={{ opacity: sidebarShownTemporary ? 0.5 : 0 }}
				/>
			)}

			<motion.div
				initial={{ width: navWidthPx }}
				animate={{ width: sidebarIsHidden ? NAV_COLLAPSED_WIDTH : navWidthPx }}
				transition={isResizing ? { duration: 0 } : { duration: 0.25, type: 'spring', bounce: 0 }}
				className='relative h-full'
				onMouseEnter={handleMouseEnter}
			/>

			<motion.div
				ref={navRef}
				initial={{ left: 0 }}
				animate={{ left: sidebarIsHidden && !sidebarShownTemporary ? -navWidthPx : 0 }}
				transition={isResizing ? { duration: 0 } : { duration: 0.25, type: 'spring', bounce: 0 }}
				style={{ width: `${renderWidth}rem` }}
				className={cn(
					'fixed top-0 bottom-0 z-40 flex h-full items-end pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
					sidebarIsHidden && 'bottom-2 pl-2',
				)}
				onMouseLeave={handleMouseLeave}
			>
				<nav
					className={cn(
						'relative flex h-full w-full flex-col gap-4 bg-sidebar p-3 transition-all',
						sidebarIsHidden &&
							'mr-2 mb-2 h-[calc(100%-1rem)] rounded-xl border border-sidebar-border px-3.5',
					)}
				>
					{children}
					{(!sidebarIsHidden || sidebarShownTemporary) && (
						<button
							type='button'
							aria-label='Resize sidebar'
							onMouseDown={event => {
								event.preventDefault()
								startResize(event.clientX)
							}}
							className={cn(
								'absolute top-0 -right-2 bottom-0 z-10 hidden w-4 cursor-col-resize border-0 bg-transparent p-0 after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors md:block',
								isResizing ? 'after:bg-ring/50' : 'hover:after:bg-ring/50',
							)}
						/>
					)}
				</nav>
			</motion.div>
		</div>
	)
}
