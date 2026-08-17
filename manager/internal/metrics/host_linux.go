//go:build linux

package metrics

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// cpuPercent samples /proc/stat twice; containers see the host file, which is
// exactly what the dashboard should report.
func cpuPercent() float64 {
	first, firstIdle, ok := cpuTotals()
	if !ok {
		return 0
	}
	time.Sleep(200 * time.Millisecond)
	second, secondIdle, ok := cpuTotals()
	if !ok {
		return 0
	}
	totalDelta := float64(second - first)
	idleDelta := float64(secondIdle - firstIdle)
	if totalDelta <= 0 {
		return 0
	}
	return (totalDelta - idleDelta) / totalDelta * 100
}

func cpuTotals() (total, idle uint64, ok bool) {
	body, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		for i, field := range strings.Fields(line)[1:] {
			v, err := strconv.ParseUint(field, 10, 64)
			if err != nil {
				continue
			}
			total += v
			// Fields 3 and 4 are idle and iowait.
			if i == 3 || i == 4 {
				idle += v
			}
		}
		return total, idle, true
	}
	return 0, 0, false
}

func memory() (used, total uint64) {
	body, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	values := map[string]uint64{}
	for _, line := range strings.Split(string(body), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		v, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		values[strings.TrimSuffix(parts[0], ":")] = v * 1024
	}
	total = values["MemTotal"]
	available, ok := values["MemAvailable"]
	if !ok {
		available = values["MemFree"] + values["Buffers"] + values["Cached"]
	}
	if total > available {
		used = total - available
	}
	return used, total
}

func disk(path string) (used, total uint64) {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0, 0
	}
	blockSize := uint64(fs.Bsize)
	total = fs.Blocks * blockSize
	free := fs.Bavail * blockSize
	if total > free {
		used = total - free
	}
	return used, total
}

func loadAverage() float64 {
	body, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(body))
	if len(fields) == 0 {
		return 0
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	return v
}
