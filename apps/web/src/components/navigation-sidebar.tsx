import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** Width bounds of the navigation panel, in rem (219px / 329px / 252px). */
export const MIN_NAV_WIDTH_REM = 13.6875
export const MAX_NAV_WIDTH_REM = 20.5625
export const DEFAULT_NAV_WIDTH_REM = 15.75
/** Width of the hover hit-target left behind when the sidebar is hidden. */
const NAV_COLLAPSED_WIDTH = 8

const WIDTH_KEY = 'navigation-leftBarWidth'

// The stored width is read after hydration so the prerendered markup and the
// first client render agree; a layout effect applies it before the paint.
const useHydrationEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * The shell's left rail: a fixed, resizable panel that can be hidden entirely
 * and slid back in by hovering the screen edge. Hidden state is owned by the
 * caller because the toggle lives in the navigation it renders.
 */
export function NavigationSidebar({
  children,
  isHidden = false,
  showTemporary = false,
  onShowTemporaryChange,
}: {
  children: ReactNode
  isHidden?: boolean
  showTemporary?: boolean
  onShowTemporaryChange?: (show: boolean) => void
}) {
  const [width, setWidth] = useState(DEFAULT_NAV_WIDTH_REM)
  const [isResizing, setIsResizing] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)

  useHydrationEffect(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    if (stored >= MIN_NAV_WIDTH_REM && stored <= MAX_NAV_WIDTH_REM) setWidth(stored)
  }, [])

  const widthPx = width * 16
  const transition = isResizing ? '' : 'transition-[width,left] duration-[250ms] ease-out'

  const startResize = (startX: number) => {
    setIsResizing(true)
    const startWidth = width
    let next = width

    const onMove = (event: MouseEvent) => {
      const raw = isHidden ? event.clientX / 16 : startWidth + (event.clientX - startX) / 16
      next = Math.min(MAX_NAV_WIDTH_REM, Math.max(MIN_NAV_WIDTH_REM, raw))
      setWidth(next)
    }

    const onUp = (event: MouseEvent) => {
      setIsResizing(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem(WIDTH_KEY, String(next))

      if (isHidden) {
        const bounds = navRef.current?.getBoundingClientRect()
        const overNav =
          bounds !== undefined &&
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY <= bounds.bottom
        if (!overNav) onShowTemporaryChange?.(false)
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div className="relative">
      {/* Dims the page while the hidden sidebar is peeked at. */}
      <div
        className={cn(
          'bg-sidebar fixed inset-y-0 right-0 left-0 transition-opacity duration-[250ms]',
          showTemporary ? 'opacity-50' : 'pointer-events-none opacity-0',
        )}
      />

      {/* Spacer: the only thing that reserves layout width for the rail. */}
      <div
        className={cn('relative h-full', transition)}
        style={{ width: isHidden ? NAV_COLLAPSED_WIDTH : widthPx }}
        onMouseEnter={() => isHidden && onShowTemporaryChange?.(true)}
      />

      <div
        ref={navRef}
        className={cn(
          'fixed top-0 bottom-0 z-40 flex h-full items-end pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
          isHidden && 'bottom-2 pl-2',
          transition,
        )}
        style={{ width: `${width}rem`, left: isHidden && !showTemporary ? -widthPx : 0 }}
        onMouseLeave={() => !isResizing && isHidden && onShowTemporaryChange?.(false)}
      >
        <nav
          className={cn(
            'bg-sidebar relative flex h-full w-full flex-col gap-4 p-3 transition-all',
            isHidden && 'mr-2 mb-2 h-[calc(100%-1rem)] rounded-xl border border-zinc-800 px-3.5',
          )}
        >
          {children}
          {(!isHidden || showTemporary) && (
            <button
              type="button"
              aria-label="Resize sidebar"
              onMouseDown={(event) => {
                event.preventDefault()
                startResize(event.clientX)
              }}
              className={cn(
                'absolute top-0 -right-2 bottom-0 z-10 hidden w-4 cursor-col-resize border-0 bg-transparent p-0 after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors md:block',
                isResizing ? 'after:bg-zinc-500/50' : 'hover:after:bg-zinc-500/50',
              )}
            />
          )}
        </nav>
      </div>
    </div>
  )
}
