import type { ReactNode } from 'react'

import { Button as ShadcnButton } from '@/components/ui/button'
import { Empty as ShadcnEmpty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Field as ShadcnField, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Table as ShadcnTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

/**
 * The vocabulary every page speaks. Each one wraps a shadcn component so the
 * whole panel inherits one design system, while keeping the dense, flat layout
 * the dashboard needs.
 */

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

// Local intent names map onto shadcn variants, so pages never spell out
// "destructive" or "outline" and the mapping can change in one place.
const buttonVariants = {
  default: 'outline',
  primary: 'default',
  danger: 'destructive',
  ghost: 'ghost',
} as const satisfies Record<ButtonVariant, string>

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
}) {
  return (
    <ShadcnButton
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      size="sm"
      variant={buttonVariants[variant]}
      className={cn('h-7 px-2.5 text-xs', variant === 'ghost' && 'text-muted-foreground hover:text-foreground')}
    >
      {children}
    </ShadcnButton>
  )
}

const stateColor: Record<string, string> = {
  running: 'text-emerald-400',
  healthy: 'text-emerald-400',
  success: 'text-emerald-400',
  issued: 'text-emerald-400',
  starting: 'text-amber-400',
  queued: 'text-amber-400',
  restarting: 'text-amber-400',
  pending: 'text-amber-400',
  unhealthy: 'text-red-400',
  failed: 'text-red-400',
  dead: 'text-red-400',
  exited: 'text-muted-foreground',
  stopped: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
  created: 'text-muted-foreground',
  paused: 'text-muted-foreground',
}

/** A status word rendered in the colour that matches its meaning. */
export function Status({ value }: { value: string }) {
  if (!value) return <span className="text-muted-foreground">-</span>
  return (
    <span className={cn('inline-flex items-center gap-1.5', stateColor[value] ?? 'text-muted-foreground')}>
      <span aria-hidden className="inline-block size-1.5 rounded-full bg-current" />
      {value}
    </span>
  )
}

export function Section({
  title,
  actions,
  children,
  description,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  description?: string
}) {
  return (
    <section className="mb-8">
      <header className="mb-2 flex h-7 items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[13px] font-medium">{title}</h2>
          {description ? <span className="text-muted-foreground text-xs">{description}</span> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <ShadcnTable>
        <TableHeader>
          <TableRow>
            {head.map((label) => (
              <TableHead key={label} className="h-8 text-[11px] tracking-wide uppercase">
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </ShadcnTable>
    </div>
  )
}

export function Row({ children }: { children: ReactNode }) {
  return <TableRow>{children}</TableRow>
}

export function Cell({ children, mono, right }: { children: ReactNode; mono?: boolean; right?: boolean }) {
  return (
    <TableCell className={cn('py-1.5', mono && 'font-mono text-xs', right && 'text-right')}>{children}</TableCell>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <ShadcnEmpty className="border-t py-8">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </ShadcnEmpty>
  )
}

/**
 * Static placeholder rows. shadcn's Skeleton pulses by default; the panel is
 * often left open on a second monitor, so the animation is switched off.
 */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="border-t">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-8 items-center gap-3 border-b">
          <span className="bg-muted h-2 w-32" />
          <span className="bg-muted/60 h-2 w-20" />
          <span className="bg-muted/60 h-2 w-16" />
        </div>
      ))}
    </div>
  )
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : String(error)
  return (
    <p role="alert" className="text-destructive py-2 text-xs">
      {message}
    </p>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <ShadcnField className="mb-3 gap-1">
      <FieldLabel className="text-muted-foreground text-[11px] tracking-wide uppercase">{label}</FieldLabel>
      {children}
      {hint ? <FieldDescription className="text-[11px]">{hint}</FieldDescription> : null}
    </ShadcnField>
  )
}
