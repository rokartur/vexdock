//go:build !linux

package metrics

// The platform targets Linux hosts; on other systems (developer machines) the
// dashboard simply shows no host metrics rather than wrong ones.

func cpuPercent() float64 { return 0 }

func memory() (used, total uint64) { return 0, 0 }

func disk(string) (used, total uint64) { return 0, 0 }

func loadAverage() float64 { return 0 }
