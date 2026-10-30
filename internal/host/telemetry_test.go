package host

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCollectorWithSyntheticProc(t *testing.T) {
	tmp := t.TempDir()
	procDir := filepath.Join(tmp, "proc")
	sysDir := filepath.Join(tmp, "sys")
	if err := os.MkdirAll(filepath.Join(procDir, "sys/kernel"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sysDir, "class/hwmon/hwmon0"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Initial /proc/stat sample
	stat1 := "cpu  1000 0 500 8500 0 0 0 0 0 0\ncpu0 500 0 250 4250 0 0 0 0 0 0\ncpu1 500 0 250 4250 0 0 0 0 0 0\n"
	if err := os.WriteFile(filepath.Join(procDir, "stat"), []byte(stat1), 0o644); err != nil {
		t.Fatal(err)
	}

	meminfo := `MemTotal:       16384000 kB
MemFree:         4096000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          3584000 kB
SReclaimable:     256000 kB
SwapTotal:       4096000 kB
SwapFree:        3072000 kB
`
	if err := os.WriteFile(filepath.Join(procDir, "meminfo"), []byte(meminfo), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(procDir, "loadavg"), []byte("1.25 0.90 0.65 2/410 1234\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(procDir, "uptime"), []byte("86400.50 172800.00\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(procDir, "cpuinfo"), []byte("processor\t: 0\nmodel name\t: Synthetic Test CPU @ 4.0GHz\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(procDir, "sys/kernel/osrelease"), []byte("6.8.0-generic\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sysDir, "class/hwmon/hwmon0/name"), []byte("coretemp\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sysDir, "class/hwmon/hwmon0/temp1_input"), []byte("48500\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	collector := NewCollectorWithRoots(procDir, sysDir)

	// Second /proc/stat sample: +250 busy, +750 idle => 25% CPU
	stat2 := "cpu  1200 0 550 9250 0 0 0 0 0 0\ncpu0 600 0 300 4600 0 0 0 0 0 0\ncpu1 600 0 250 4650 0 0 0 0 0 0\n"
	if err := os.WriteFile(filepath.Join(procDir, "stat"), []byte(stat2), 0o644); err != nil {
		t.Fatal(err)
	}

	snap := collector.Collect(tmp)
	if snap.CPUPercent != 25.0 {
		t.Fatalf("expected CPUPercent 25.0, got %v", snap.CPUPercent)
	}
	if len(snap.PerCore) != 2 {
		t.Fatalf("expected 2 cores, got %d", len(snap.PerCore))
	}
	if snap.MemPercent != 50.0 {
		t.Fatalf("expected MemPercent 50.0, got %v", snap.MemPercent)
	}
	if snap.Load1 != 1.25 || snap.Load5 != 0.90 || snap.Load15 != 0.65 {
		t.Fatalf("unexpected load averages: %+v", snap)
	}
	if snap.CPUModel != "Synthetic Test CPU @ 4.0GHz" {
		t.Fatalf("unexpected CPUModel: %q", snap.CPUModel)
	}
	if snap.CPUTempC == nil || *snap.CPUTempC != 48.5 {
		t.Fatalf("expected CPUTempC 48.5, got %v", snap.CPUTempC)
	}
}
