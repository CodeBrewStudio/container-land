package host

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// CoreLoad represents the utilisation of a single CPU core.
type CoreLoad struct {
	Core    string  `json:"core"`
	Percent float64 `json:"percent"`
}

// DiskSpace represents capacity and usage for a mounted filesystem.
type DiskSpace struct {
	Path        string  `json:"path"`
	TotalBytes  uint64  `json:"totalBytes"`
	UsedBytes   uint64  `json:"usedBytes"`
	FreeBytes   uint64  `json:"freeBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

// Snapshot holds a point-in-time host resource telemetry reading.
type Snapshot struct {
	Timestamp     time.Time  `json:"timestamp"`
	Hostname      string     `json:"hostname"`
	KernelVersion string     `json:"kernelVersion"`
	CPUModel      string     `json:"cpuModel"`
	CPUCores      int        `json:"cpuCores"`
	CPUPercent    float64    `json:"cpuPercent"`
	PerCore       []CoreLoad `json:"perCore,omitempty"`
	CPUTempC      *float64   `json:"cpuTempC,omitempty"`
	MemTotalBytes uint64     `json:"memTotalBytes"`
	MemUsedBytes  uint64     `json:"memUsedBytes"`
	MemCacheBytes uint64     `json:"memCacheBytes"`
	MemAvailBytes uint64     `json:"memAvailBytes"`
	MemPercent    float64    `json:"memPercent"`
	SwapTotal     uint64     `json:"swapTotalBytes"`
	SwapUsed      uint64     `json:"swapUsedBytes"`
	Load1         float64    `json:"load1"`
	Load5         float64    `json:"load5"`
	Load15        float64    `json:"load15"`
	UptimeSeconds float64    `json:"uptimeSeconds"`
	RootDisk      DiskSpace  `json:"rootDisk"`
	DockerDisk    DiskSpace  `json:"dockerDisk"`
}

type cpuTimes struct {
	total uint64
	idle  uint64
}

// Collector reads host metrics from Linux /proc and statfs.
type Collector struct {
	procRoot string
	sysRoot  string
	mu       sync.Mutex
	prevCPU  map[string]cpuTimes
}

// NewCollector creates a new host telemetry collector and primes initial CPU counters.
func NewCollector() *Collector {
	return NewCollectorWithRoots("/proc", "/sys")
}

// NewCollectorWithRoots creates a collector reading from custom /proc and /sys roots (for testing).
func NewCollectorWithRoots(procRoot, sysRoot string) *Collector {
	c := &Collector{
		procRoot: procRoot,
		sysRoot:  sysRoot,
		prevCPU:  make(map[string]cpuTimes),
	}
	c.prevCPU = c.readCPUTimes()
	return c
}

// Collect gathers a fresh host telemetry Snapshot.
func (c *Collector) Collect(dockerRootDir string) Snapshot {
	hostname, _ := os.Hostname()
	snap := Snapshot{
		Timestamp:     time.Now().UTC(),
		Hostname:      hostname,
		KernelVersion: c.readKernelVersion(),
		CPUModel:      c.readCPUModel(),
		CPUCores:      runtime.NumCPU(),
	}

	c.mu.Lock()
	currCPU := c.readCPUTimes()
	if prevAll, ok := c.prevCPU["cpu"]; ok {
		if currAll, ok2 := currCPU["cpu"]; ok2 {
			snap.CPUPercent = calcCPUPercent(prevAll, currAll)
		}
	}
	var perCore []CoreLoad
	for i := 0; i < 256; i++ {
		key := "cpu" + strconv.Itoa(i)
		curr, exists := currCPU[key]
		if !exists {
			break
		}
		var pct float64
		if prev, ok := c.prevCPU[key]; ok {
			pct = calcCPUPercent(prev, curr)
		}
		perCore = append(perCore, CoreLoad{
			Core:    key,
			Percent: pct,
		})
	}
	if len(perCore) > 0 {
		snap.CPUCores = len(perCore)
		snap.PerCore = perCore
	}
	c.prevCPU = currCPU
	c.mu.Unlock()

	c.populateMemory(&snap)
	c.populateLoadAndUptime(&snap)
	snap.CPUTempC = c.readCPUTemp()
	snap.RootDisk = statFilesystem("/")

	if dockerRootDir == "" {
		dockerRootDir = "/var/lib/docker"
	}
	dockerDisk := statFilesystem(dockerRootDir)
	if dockerDisk.TotalBytes == 0 {
		dockerDisk = snap.RootDisk
		dockerDisk.Path = dockerRootDir
	}
	snap.DockerDisk = dockerDisk

	return snap
}

func calcCPUPercent(prev, curr cpuTimes) float64 {
	if curr.total <= prev.total {
		return 0
	}
	totalDelta := float64(curr.total - prev.total)
	idleDelta := float64(0)
	if curr.idle >= prev.idle {
		idleDelta = float64(curr.idle - prev.idle)
	}
	used := totalDelta - idleDelta
	if used < 0 {
		return 0
	}
	pct := (used / totalDelta) * 100.0
	if pct > 100.0 {
		return 100.0
	}
	return roundTwo(pct)
}

func (c *Collector) readCPUTimes() map[string]cpuTimes {
	res := make(map[string]cpuTimes)
	f, err := os.Open(filepath.Join(c.procRoot, "stat"))
	if err != nil {
		return res
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "cpu") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		name := fields[0]
		var total, idle uint64
		for i, raw := range fields[1:] {
			val, err := strconv.ParseUint(raw, 10, 64)
			if err != nil {
				continue
			}
			total += val
			// fields[1:] indices: 0=user, 1=nice, 2=system, 3=idle, 4=iowait
			if i == 3 || i == 4 {
				idle += val
			}
		}
		res[name] = cpuTimes{total: total, idle: idle}
	}
	return res
}

func (c *Collector) populateMemory(snap *Snapshot) {
	f, err := os.Open(filepath.Join(c.procRoot, "meminfo"))
	if err != nil {
		return
	}
	defer f.Close()

	vals := make(map[string]uint64)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		parts := strings.Fields(scanner.Text())
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		v, err := strconv.ParseUint(parts[1], 10, 64)
		if err == nil {
			vals[key] = v * 1024 // kB to bytes
		}
	}

	total := vals["MemTotal"]
	avail := vals["MemAvailable"]
	buffers := vals["Buffers"]
	cached := vals["Cached"] + vals["SReclaimable"]
	if avail == 0 && total > 0 {
		avail = vals["MemFree"] + buffers + cached
	}
	var used uint64
	if total > avail {
		used = total - avail
	}

	snap.MemTotalBytes = total
	snap.MemAvailBytes = avail
	snap.MemUsedBytes = used
	snap.MemCacheBytes = buffers + cached
	if total > 0 {
		snap.MemPercent = roundTwo((float64(used) / float64(total)) * 100.0)
	}

	swapTotal := vals["SwapTotal"]
	swapFree := vals["SwapFree"]
	snap.SwapTotal = swapTotal
	if swapTotal > swapFree {
		snap.SwapUsed = swapTotal - swapFree
	}
}

func (c *Collector) populateLoadAndUptime(snap *Snapshot) {
	if data, err := os.ReadFile(filepath.Join(c.procRoot, "loadavg")); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			snap.Load1, _ = strconv.ParseFloat(fields[0], 64)
			snap.Load5, _ = strconv.ParseFloat(fields[1], 64)
			snap.Load15, _ = strconv.ParseFloat(fields[2], 64)
		}
	}
	if data, err := os.ReadFile(filepath.Join(c.procRoot, "uptime")); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 1 {
			snap.UptimeSeconds, _ = strconv.ParseFloat(fields[0], 64)
		}
	}
}

func (c *Collector) readKernelVersion() string {
	data, err := os.ReadFile(filepath.Join(c.procRoot, "sys/kernel/osrelease"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (c *Collector) readCPUModel() string {
	f, err := os.Open(filepath.Join(c.procRoot, "cpuinfo"))
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "model name") {
			if idx := strings.IndexByte(line, ':'); idx != -1 {
				return strings.TrimSpace(line[idx+1:])
			}
		}
	}
	return ""
}

func (c *Collector) readCPUTemp() *float64 {
	hwmonGlob := filepath.Join(c.sysRoot, "class/hwmon/hwmon*")
	dirs, err := filepath.Glob(hwmonGlob)
	if err != nil {
		return nil
	}
	for _, dir := range dirs {
		nameBytes, err := os.ReadFile(filepath.Join(dir, "name"))
		if err != nil {
			continue
		}
		name := strings.TrimSpace(string(nameBytes))
		if name != "k10temp" && name != "coretemp" && name != "zenpower" && name != "cpu_thermal" {
			continue
		}
		tempFiles, _ := filepath.Glob(filepath.Join(dir, "temp*_input"))
		for _, tf := range tempFiles {
			raw, err := os.ReadFile(tf)
			if err != nil {
				continue
			}
			milli, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
			if err == nil && milli > 0 {
				deg := roundTwo(milli / 1000.0)
				return &deg
			}
		}
	}
	return nil
}

func statFilesystem(path string) DiskSpace {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return DiskSpace{Path: path}
	}
	bsize := uint64(st.Bsize)
	total := st.Blocks * bsize
	free := st.Bavail * bsize
	var used uint64
	if total > free {
		used = total - free
	}
	var pct float64
	if total > 0 {
		pct = roundTwo((float64(used) / float64(total)) * 100.0)
	}
	return DiskSpace{
		Path:        path,
		TotalBytes:  total,
		UsedBytes:   used,
		FreeBytes:   free,
		UsedPercent: pct,
	}
}

func roundTwo(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100.0
}
