import type { ReactNode } from 'react'

/** Shared primitives. Deliberately flat: no cards, no pills, no gradients. */

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
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
}) {
  const styles = {
    default: 'border-[#2e2e2e] hover:border-[#4a4a4a]',
    primary: 'border-white bg-white text-black hover:bg-[#e6e6e6]',
    danger: 'border-[#552] text-[#ff5f56] hover:border-[#ff5f56]',
    ghost: 'border-transparent text-[#8a8a8a] hover:text-white',
  }[variant]
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`h-7 rounded-[2px] border px-2.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  )
}

const stateColor: Record<string, string> = {
  running: 'text-[#3ddc84]',
  healthy: 'text-[#3ddc84]',
  success: 'text-[#3ddc84]',
  issued: 'text-[#3ddc84]',
  starting: 'text-[#f5c451]',
  queued: 'text-[#f5c451]',
  restarting: 'text-[#f5c451]',
  pending: 'text-[#f5c451]',
  unhealthy: 'text-[#ff5f56]',
  failed: 'text-[#ff5f56]',
  dead: 'text-[#ff5f56]',
  exited: 'text-[#8a8a8a]',
  stopped: 'text-[#8a8a8a]',
  cancelled: 'text-[#8a8a8a]',
  created: 'text-[#8a8a8a]',
  paused: 'text-[#8a8a8a]',
}

/** A status word rendered in the colour that matches its meaning. */
export function Status({ value }: { value: string }) {
  if (!value) return <span className="text-[#8a8a8a]">-</span>
  const running = value === 'running'
  return (
    <span className={`inline-flex items-center gap-1.5 ${stateColor[value] ?? 'text-[#8a8a8a]'}`}>
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-current"
        style={{ opacity: running ? 1 : 0.7 }}
      />
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
          {description ? <span className="text-[12px] text-[#8a8a8a]">{description}</span> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto border-t border-[#1f1f1f]">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {head.map((label) => (
              <th
                key={label}
                className="border-b border-[#1f1f1f] py-1.5 pr-4 text-[11px] font-normal tracking-wide text-[#8a8a8a] uppercase"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function Row({ children }: { children: ReactNode }) {
  return <tr className="border-b border-[#141414] hover:bg-[#0a0a0a]">{children}</tr>
}

export function Cell({ children, mono, right }: { children: ReactNode; mono?: boolean; right?: boolean }) {
  return (
    <td
      className={`py-1.5 pr-4 align-middle ${mono ? 'font-mono text-[12px]' : ''} ${right ? 'text-right' : ''}`}
    >
      {children}
    </td>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="border-t border-[#1f1f1f] py-6 text-[12px] text-[#8a8a8a]">{children}</p>
}

/** Static skeleton: no shimmer, so an idle tab costs nothing to render. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="border-t border-[#1f1f1f]">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-8 items-center gap-3 border-b border-[#141414]">
          <span className="h-2 w-32 bg-[#141414]" />
          <span className="h-2 w-20 bg-[#111]" />
          <span className="h-2 w-16 bg-[#111]" />
        </div>
      ))}
    </div>
  )
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : String(error)
  return <p className="py-2 text-[12px] text-[#ff5f56]">{message}</p>
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11px] tracking-wide text-[#8a8a8a] uppercase">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-[#8a8a8a]">{hint}</span> : null}
    </label>
  )
}
