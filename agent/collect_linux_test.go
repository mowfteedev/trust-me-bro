//go:build linux

package main

import "testing"

func TestCPU(t *testing.T) {
	// guest/guest_nice (last two values) are already in user/nice.
	current, err := parseCPU("cpu 400 100 300 1200 0 0 0 0 80 20\ncpu0 ignored")
	if err != nil || current.total != 2000 || current.idle != 1200 {
		t.Fatalf("bad CPU counters: %+v, %v", current, err)
	}
	percent, err := cpuPercent(cpuTimes{idle: 1000, total: 1000}, current)
	if err != nil || percent != 80 {
		t.Fatalf("expected 80%%, got %v (%v)", percent, err)
	}
	for _, raw := range []string{"", "cpu 1 2", "cpu 1 2 3 -4 5 6 7 8", "cpu 18446744073709551615 1 0 0 0 0 0 0"} {
		if _, err := parseCPU(raw); err == nil {
			t.Fatalf("accepted invalid CPU %q", raw)
		}
	}
	for _, current := range []cpuTimes{{100, 100}, {99, 200}, {250, 200}} {
		if _, err := cpuPercent(cpuTimes{100, 100}, current); err == nil {
			t.Fatalf("accepted reset/inconsistent CPU counters: %+v", current)
		}
	}
}

func TestMemory(t *testing.T) {
	metric, err := parseMemory("MemTotal: 16384000 kB\nMemFree: 100 kB\nMemAvailable: 8192000 kB\nCached: 100000 kB\n")
	if err != nil || metric.TotalBytes != 16384000*1024 || metric.UsedBytes != 8192000*1024 || metric.Percent != 50 {
		t.Fatalf("wrong MemAvailable calculation: %+v (%v)", metric, err)
	}
	for _, raw := range []string{"", "MemTotal: 100 kB", "MemTotal: 0 kB\nMemAvailable: 0 kB", "MemTotal: 100 kB\nMemAvailable: 101 kB", "MemTotal: 100 MB\nMemAvailable: 0 kB", "MemTotal: -1 kB\nMemAvailable: 0 kB"} {
		if _, err := parseMemory(raw); err == nil {
			t.Fatalf("accepted invalid memory %q", raw)
		}
	}
}

func TestNetworkUsesOneInterface(t *testing.T) {
	raw := "Inter-| Receive | Transmit\n" +
		"lo: 9999999 0 0 0 0 0 0 0 9999999 0 0 0 0 0 0 0\n" +
		"eth0: 1048576 0 0 0 0 0 0 0 2097152 0 0 0 0 0 0 0\n" +
		"wg0: 524288 0 0 0 0 0 0 0 262144 0 0 0 0 0 0 0\n"
	metric, err := parseNetwork(raw, "wg0")
	if err != nil || metric.RXBytesTotal != 524288 || metric.TXBytesTotal != 262144 {
		t.Fatalf("network counted extra interfaces: %+v (%v)", metric, err)
	}
	for _, raw := range []string{"eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0", "wg0: 0", "wg0: -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"} {
		if _, err := parseNetwork(raw, "wg0"); err == nil {
			t.Fatalf("accepted absent/invalid interface: %q", raw)
		}
	}
}

func TestLoadUptimeAndDisk(t *testing.T) {
	load, err := parseLoad("0.12 1.35 2.50 1/123 123")
	if err != nil || load != [3]float64{0.12, 1.35, 2.5} {
		t.Fatalf("load: %v %v", load, err)
	}
	uptime, err := parseUptime("1234.99 4321.00")
	if err != nil || uptime != 1234 {
		t.Fatalf("uptime: %v %v", uptime, err)
	}
	for _, raw := range []string{"", "NaN 0 0", "-1 0 0"} {
		if _, err := parseLoad(raw); err == nil {
			t.Fatalf("accepted invalid load %q", raw)
		}
		if _, err := parseUptime(raw); err == nil {
			t.Fatalf("accepted invalid uptime %q", raw)
		}
	}
	metric, err := readDisk(t.TempDir())
	if err != nil || metric.TotalBytes == 0 || metric.UsedBytes > metric.TotalBytes || metric.Percent < 0 || metric.Percent > 100 {
		t.Fatalf("real Linux statfs: %+v (%v)", metric, err)
	}
	if _, err := readDisk(t.TempDir() + "/missing"); err == nil {
		t.Fatal("missing disk mount returned fabricated data")
	}
}
