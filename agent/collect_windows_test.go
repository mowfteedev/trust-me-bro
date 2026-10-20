//go:build windows && (amd64 || arm64)

package main

import (
	"net"
	"os"
	"testing"
	"time"
	"unsafe"
)

func TestWindowsABIAndConfig(t *testing.T) {
	if unsafe.Sizeof(interfaceRow{}) != 1352 || unsafe.Offsetof(interfaceRow{}.InOctets) != 1208 || unsafe.Offsetof(interfaceRow{}.OutOctets) != 1280 || unsafe.Sizeof(memoryStatusEx{}) != 64 {
		t.Fatal("Win32 collector structure layout differs from 64-bit Windows ABI")
	}
	cfg := config{NetworkInterface: "zt-worker", DiskMountPoint: `C:\`}
	if err := validatePlatformConfig(cfg); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{`\\server\share`, `\\?\C:\`, `C:relative`, `/`, "C:\\bad\npath"} {
		cfg.DiskMountPoint = path
		if validatePlatformConfig(cfg) == nil {
			t.Fatalf("accepted remote/invalid disk path %q", path)
		}
	}
}

// This test must execute on Windows to prove the API calls; cross-compiling it
// on Linux is only a build check and must never be reported as a native PASS.
func TestWindowsNativeCollector(t *testing.T) {
	interfaces, err := net.Interfaces()
	if err != nil || len(interfaces) == 0 {
		t.Fatalf("cannot enumerate native interfaces: %v", err)
	}
	cfg := config{NodeID: "windows-native-test", NetworkInterface: interfaces[0].Name, DiskMountPoint: os.Getenv("SystemDrive") + `\`}
	c, err := newCollector(cfg)
	if err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(100 * time.Millisecond) // CPU utilization requires two real samples.
	defer timer.Stop()
	<-timer.C
	payload, err := c.collect()
	if err != nil {
		t.Fatal(err)
	}
	m := payload.Metrics
	if payload.NodeID != cfg.NodeID || payload.Timestamp <= 0 || m.CPU.LoadAvg != nil || m.CPU.Percent < 0 || m.CPU.Percent > 100 || m.Memory.TotalBytes == 0 || m.Memory.UsedBytes > m.Memory.TotalBytes || m.Disk.TotalBytes == 0 || m.Disk.UsedBytes > m.Disk.TotalBytes {
		t.Fatalf("invalid native sample: %+v", payload)
	}
	if _, err := readNetwork("zt-nonexistent-test-interface"); err == nil {
		t.Fatal("missing interface returned fabricated network counters")
	}
	if _, err := readDisk(cfg.DiskMountPoint + "zt-missing-test-folder"); err == nil {
		t.Fatal("missing disk path returned fabricated capacity")
	}
}
