export function Logo({ className }: { className?: string }) {
	return (
		<svg viewBox='0 0 24 24' fill='currentColor' aria-hidden className={className}>
			<rect x='0' y='0' width='6.5' height='6.5' rx='1.4' />
			<rect x='17.5' y='0' width='6.5' height='6.5' rx='1.4' />
			<rect x='8.75' y='8.75' width='6.5' height='6.5' rx='1.4' />
			<rect x='0' y='17.5' width='6.5' height='6.5' rx='1.4' />
			<rect x='8.75' y='17.5' width='6.5' height='6.5' rx='1.4' />
			<rect x='17.5' y='17.5' width='6.5' height='6.5' rx='1.4' />
		</svg>
	)
}
