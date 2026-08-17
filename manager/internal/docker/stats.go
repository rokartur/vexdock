package docker

import "github.com/docker/docker/api/types/container"

// Sample is the flattened per-container metric the UI renders.
type Sample struct {
	ContainerID string  `json:"container_id"`
	Name        string  `json:"name"`
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryUsage uint64  `json:"memory_usage"`
	MemoryLimit uint64  `json:"memory_limit"`
	MemoryPct   float64 `json:"memory_percent"`
	NetworkRX   uint64  `json:"network_rx"`
	NetworkTX   uint64  `json:"network_tx"`
	BlockRead   uint64  `json:"block_read"`
	BlockWrite  uint64  `json:"block_write"`
	PIDs        uint64  `json:"pids"`
}

// SampleFrom converts a raw Docker stats frame into a Sample. CPU percentage
// needs the previous frame embedded in the response, which the Engine provides.
func SampleFrom(s *container.StatsResponse) Sample {
	sample := Sample{
		ContainerID: s.ID,
		Name:        trimSlash(s.Name),
		MemoryUsage: memoryUsage(s.MemoryStats),
		MemoryLimit: s.MemoryStats.Limit,
		PIDs:        s.PidsStats.Current,
	}
	if sample.MemoryLimit > 0 {
		sample.MemoryPct = float64(sample.MemoryUsage) / float64(sample.MemoryLimit) * 100
	}
	sample.CPUPercent = cpuPercent(s)
	for _, n := range s.Networks {
		sample.NetworkRX += n.RxBytes
		sample.NetworkTX += n.TxBytes
	}
	for _, e := range s.BlkioStats.IoServiceBytesRecursive {
		switch e.Op {
		case "read", "Read":
			sample.BlockRead += e.Value
		case "write", "Write":
			sample.BlockWrite += e.Value
		}
	}
	return sample
}

// memoryUsage subtracts the page cache the way `docker stats` does, so the
// number in the panel matches the number on the CLI.
func memoryUsage(m container.MemoryStats) uint64 {
	if v, ok := m.Stats["inactive_file"]; ok && v < m.Usage {
		return m.Usage - v
	}
	if v, ok := m.Stats["total_inactive_file"]; ok && v < m.Usage {
		return m.Usage - v
	}
	if m.Stats["cache"] < m.Usage {
		return m.Usage - m.Stats["cache"]
	}
	return m.Usage
}

func cpuPercent(s *container.StatsResponse) float64 {
	cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(s.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(s.CPUStats.SystemUsage) - float64(s.PreCPUStats.SystemUsage)
	if cpuDelta <= 0 || systemDelta <= 0 {
		return 0
	}
	cpus := float64(s.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = float64(len(s.CPUStats.CPUUsage.PercpuUsage))
	}
	if cpus == 0 {
		cpus = 1
	}
	return (cpuDelta / systemDelta) * cpus * 100
}

func trimSlash(name string) string {
	if len(name) > 0 && name[0] == '/' {
		return name[1:]
	}
	return name
}
