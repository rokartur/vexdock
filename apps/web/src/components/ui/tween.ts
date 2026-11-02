// Drives shapes painted from JS (svg paths, canvas) on the same curves as the CSS tokens:
// a WAAPI clock with no keyframes reports the eased progress, read once per frame.
export function tween(
	durationMs: number,
	easing: 'spring' | 'enter' | 'standard',
	onFrame: (progress: number) => void,
): () => void {
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
		onFrame(1)
		return () => {}
	}
	const curve = getComputedStyle(document.documentElement).getPropertyValue(`--ease-${easing}`)
	const effect = new KeyframeEffect(null, null, { duration: durationMs, easing: curve, fill: 'forwards' })
	const clock = new Animation(effect, document.timeline)
	clock.play()
	let frame = 0
	step()
	function step() {
		const done = clock.playState === 'finished'
		onFrame(done ? 1 : (effect.getComputedTiming().progress ?? 0))
		if (!done) frame = requestAnimationFrame(step)
	}
	return () => {
		cancelAnimationFrame(frame)
		clock.cancel()
	}
}
