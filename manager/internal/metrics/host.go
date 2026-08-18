// Package metrics reports host-level CPU, memory and disk usage for the
// dashboard, and samples it into the database on a tick so the panel can draw
// history instead of only what arrived while the page was open.
package metrics

// Host is the snapshot rendered on the dashboard.
type Host struct {
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryUsed  uint64  `json:"memory_used"`
	MemoryTotal uint64  `json:"memory_total"`
	DiskUsed    uint64  `json:"disk_used"`
	DiskTotal   uint64  `json:"disk_total"`
	LoadAverage float64 `json:"load_average"`
}

// Read samples the host. path selects the filesystem reported as disk usage.
func Read(path string) Host {
	h := Host{}
	h.CPUPercent = cpuPercent()
	h.MemoryUsed, h.MemoryTotal = memory()
	h.DiskUsed, h.DiskTotal = disk(path)
	h.LoadAverage = loadAverage()
	return h
}
