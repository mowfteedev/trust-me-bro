//go:build windows && (amd64 || arm64)

package main

import (
	"fmt"
	"math"
	"syscall"
	"time"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll") // Windows KnownDLL.
var getSystemTimes = kernel32.NewProc("GetSystemTimes")
var globalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
var getDiskFreeSpaceEx = kernel32.NewProc("GetDiskFreeSpaceExW")
var getTickCount64 = kernel32.NewProc("GetTickCount64")

// Resolve non-KnownDLLs from the OS directory, never the working directory.
func systemDLL(name string) *syscall.LazyDLL {
	var path [260]uint16
	n, _, _ := kernel32.NewProc("GetSystemDirectoryW").Call(uintptr(unsafe.Pointer(&path[0])), uintptr(len(path)))
	if n == 0 || n >= uintptr(len(path)) {
		panic("cannot resolve Windows system directory")
	}
	return syscall.NewLazyDLL(syscall.UTF16ToString(path[:n]) + "\\" + name)
}

var iphlpapi = systemDLL("iphlpapi.dll")
var convertInterfaceAliasToLuid = iphlpapi.NewProc("ConvertInterfaceAliasToLuid")
var getIfEntry2 = iphlpapi.NewProc("GetIfEntry2")

type collector struct {
	cfg      config
	previous cpuTimes
}

func readCPU() (cpuTimes, error) {
	var idle, kernel, user syscall.Filetime
	ok, _, err := getSystemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kernel)), uintptr(unsafe.Pointer(&user)))
	if ok == 0 {
		return cpuTimes{}, fmt.Errorf("GetSystemTimes: %w", err)
	}
	ticks := func(ft syscall.Filetime) uint64 { return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime) }
	k, u := ticks(kernel), ticks(user)
	if k > math.MaxUint64-u {
		return cpuTimes{}, fmt.Errorf("CPU counters overflow")
	}
	// Windows kernel time already includes idle; do not add idle a second time.
	return cpuTimes{idle: ticks(idle), total: k + u}, nil
}

func newCollector(cfg config) (*collector, error) {
	initial, err := readCPU()
	return &collector{cfg: cfg, previous: initial}, err
}

// MEMORYSTATUSEX, https://learn.microsoft.com/windows/win32/api/sysinfoapi/ns-sysinfoapi-memorystatusex
type memoryStatusEx struct {
	Length, MemoryLoad                                                                                   uint32
	TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual uint64
}

func readMemory() (capacityMetric, error) {
	status := memoryStatusEx{}
	status.Length = uint32(unsafe.Sizeof(status))
	ok, _, err := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status)))
	if ok == 0 {
		return capacityMetric{}, fmt.Errorf("GlobalMemoryStatusEx: %w", err)
	}
	return capacityFromAvailable(status.TotalPhys, status.AvailPhys)
}

func readDisk(path string) (capacityMetric, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return capacityMetric{}, fmt.Errorf("invalid disk path")
	}
	var available, total, free uint64
	ok, _, callErr := getDiskFreeSpaceEx.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&available)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free)))
	if ok == 0 {
		return capacityMetric{}, fmt.Errorf("GetDiskFreeSpaceExW: %w", callErr)
	}
	// Both counters describe capacity available to the calling service account.
	// With NTFS quotas, total may be smaller than the physical volume; mixing it
	// with physical free bytes would be inconsistent and can skip valid beacons.
	return capacityFromAvailable(total, available)
}

// MIB_IF_ROW2 layout from netioapi.h (64-bit Windows).
// https://learn.microsoft.com/windows/win32/api/netioapi/ns-netioapi-mib_if_row2
type interfaceRow struct {
	Luid                                                                            uint64
	Index                                                                           uint32
	Guid                                                                            [16]byte
	Alias, Description                                                              [257]uint16
	PhysicalAddressLength                                                           uint32
	PhysicalAddress, PermanentPhysicalAddress                                       [32]byte
	MTU, Type, TunnelType, MediaType, PhysicalMediumType, AccessType, DirectionType uint32
	Flags                                                                           uint8
	OperStatus, AdminStatus, MediaConnectState                                      uint32
	NetworkGuid                                                                     [16]byte
	ConnectionType                                                                  uint32
	TransmitLinkSpeed, ReceiveLinkSpeed                                             uint64
	InOctets, InUcastPkts, InNUcastPkts, InDiscards, InErrors, InUnknownProtos      uint64
	InUcastOctets, InMulticastOctets, InBroadcastOctets                             uint64
	OutOctets, OutUcastPkts, OutNUcastPkts, OutDiscards, OutErrors                  uint64
	OutUcastOctets, OutMulticastOctets, OutBroadcastOctets, OutQLen                 uint64
}

// A wrong ABI must fail compilation instead of allowing Win32 to overrun memory.
var _ [1352 - unsafe.Sizeof(interfaceRow{})]byte
var _ [unsafe.Sizeof(interfaceRow{}) - 1352]byte

func readNetwork(alias string) (networkMetric, error) {
	p, err := syscall.UTF16PtrFromString(alias)
	if err != nil {
		return networkMetric{}, fmt.Errorf("invalid network interface alias")
	}
	var row interfaceRow
	// Resolve each time so a recreated WireGuard adapter recovers without restart.
	status, _, _ := convertInterfaceAliasToLuid.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&row.Luid)))
	if status != 0 {
		return networkMetric{}, fmt.Errorf("network interface %s not found (Windows %d)", alias, status)
	}
	status, _, _ = getIfEntry2.Call(uintptr(unsafe.Pointer(&row)))
	if status != 0 {
		return networkMetric{}, fmt.Errorf("GetIfEntry2 failed (Windows %d)", status)
	}
	return networkMetric{RXBytesTotal: row.InOctets, TXBytesTotal: row.OutOctets}, nil
}

func (c *collector) collect() (beacon, error) {
	var result beacon
	current, err := readCPU()
	if err != nil {
		return result, err
	}
	percent, err := cpuPercent(c.previous, current)
	c.previous = current
	if err != nil {
		return result, err
	}
	// Windows does not expose Linux load averages; omit this optional field.
	result.Metrics.CPU.Percent = percent
	if result.Metrics.Memory, err = readMemory(); err != nil {
		return result, err
	}
	if result.Metrics.Disk, err = readDisk(c.cfg.DiskMountPoint); err != nil {
		return result, err
	}
	if result.Metrics.Network, err = readNetwork(c.cfg.NetworkInterface); err != nil {
		return result, err
	}
	uptime, _, _ := getTickCount64.Call()
	result.Metrics.UptimeSeconds = uint64(uptime) / 1000
	result.NodeID, result.Timestamp = c.cfg.NodeID, time.Now().UnixMilli()
	return result, nil
}
