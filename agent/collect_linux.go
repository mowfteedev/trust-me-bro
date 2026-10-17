//go:build linux

package main

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type collector struct {
	cfg      config
	previous cpuTimes
}

func newCollector(cfg config) (*collector, error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return nil, err
	}
	initial, err := parseCPU(string(data))
	return &collector{cfg: cfg, previous: initial}, err
}

// Linux user/nice already include guest time; summing only the first eight
// counters prevents counting guest/guest_nice twice. iowait counts as idle.
func parseCPU(data string) (cpuTimes, error) {
	fields := strings.Fields(strings.SplitN(data, "\n", 2)[0])
	if len(fields) < 9 || fields[0] != "cpu" {
		return cpuTimes{}, fmt.Errorf("missing aggregate CPU counters")
	}
	var result cpuTimes
	for i, text := range fields[1:9] {
		value, err := strconv.ParseUint(text, 10, 64)
		if err != nil || result.total > math.MaxUint64-value {
			return cpuTimes{}, fmt.Errorf("invalid CPU counter")
		}
		result.total += value
		if i == 3 || i == 4 {
			result.idle += value
		}
	}
	return result, nil
}

func parseMemory(data string) (capacityMetric, error) {
	values := make(map[string]uint64, 2)
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || (fields[0] != "MemTotal:" && fields[0] != "MemAvailable:") {
			continue
		}
		if len(fields) != 3 || fields[2] != "kB" {
			return capacityMetric{}, fmt.Errorf("invalid memory units")
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || value > math.MaxUint64/1024 {
			return capacityMetric{}, fmt.Errorf("invalid memory counter")
		}
		values[fields[0]] = value * 1024
	}
	total, totalOK := values["MemTotal:"]
	available, availableOK := values["MemAvailable:"]
	if !totalOK || !availableOK || total == 0 || available > total {
		return capacityMetric{}, fmt.Errorf("MemTotal/MemAvailable missing or inconsistent")
	}
	return capacity(total, total-available), nil
}

func parseNetwork(data, iface string) (networkMetric, error) {
	for _, line := range strings.Split(data, "\n") {
		name, counters, found := strings.Cut(line, ":")
		if !found || strings.TrimSpace(name) != iface {
			continue
		}
		fields := strings.Fields(counters)
		if len(fields) < 16 {
			return networkMetric{}, fmt.Errorf("incomplete counters for interface %s", iface)
		}
		rx, rxErr := strconv.ParseUint(fields[0], 10, 64)
		tx, txErr := strconv.ParseUint(fields[8], 10, 64)
		if rxErr != nil || txErr != nil {
			return networkMetric{}, fmt.Errorf("invalid network byte counters")
		}
		return networkMetric{RXBytesTotal: rx, TXBytesTotal: tx}, nil
	}
	return networkMetric{}, fmt.Errorf("network interface %s not found", iface)
}

func parseLoad(data string) ([3]float64, error) {
	var result [3]float64
	fields := strings.Fields(data)
	if len(fields) < 3 {
		return result, fmt.Errorf("load average missing")
	}
	for i := range result {
		value, err := strconv.ParseFloat(fields[i], 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return result, fmt.Errorf("invalid load average")
		}
		result[i] = value
	}
	return result, nil
}

func parseUptime(data string) (uint64, error) {
	fields := strings.Fields(data)
	if len(fields) == 0 {
		return 0, fmt.Errorf("uptime missing")
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value >= float64(math.MaxUint64) {
		return 0, fmt.Errorf("invalid uptime")
	}
	return uint64(value), nil
}

func readDisk(path string) (capacityMetric, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return capacityMetric{}, fmt.Errorf("read disk: %w", err)
	}
	if stat.Bsize <= 0 || stat.Blocks == 0 || stat.Bavail > stat.Blocks || stat.Blocks > math.MaxUint64/uint64(stat.Bsize) {
		return capacityMetric{}, fmt.Errorf("invalid filesystem capacity")
	}
	total := stat.Blocks * uint64(stat.Bsize)
	return capacity(total, total-stat.Bavail*uint64(stat.Bsize)), nil
}

func (c *collector) collect() (beacon, error) {
	read := func(path string) (string, error) {
		data, err := os.ReadFile(path)
		return string(data), err
	}
	var result beacon
	stat, err := read("/proc/stat")
	if err != nil {
		return result, err
	}
	current, err := parseCPU(stat)
	if err != nil {
		return result, err
	}
	percent, err := cpuPercent(c.previous, current)
	c.previous = current // Re-baseline after a counter reset; never report fabricated zero.
	if err != nil {
		return result, err
	}
	load, err := read("/proc/loadavg")
	if err != nil {
		return result, err
	}
	loadAverage, err := parseLoad(load)
	if err != nil {
		return result, err
	}
	result.Metrics.CPU.LoadAvg = &loadAverage
	result.Metrics.CPU.Percent = percent
	mem, err := read("/proc/meminfo")
	if err != nil {
		return result, err
	}
	if result.Metrics.Memory, err = parseMemory(mem); err != nil {
		return result, err
	}
	if result.Metrics.Disk, err = readDisk(c.cfg.DiskMountPoint); err != nil {
		return result, err
	}
	net, err := read("/proc/net/dev")
	if err != nil {
		return result, err
	}
	if result.Metrics.Network, err = parseNetwork(net, c.cfg.NetworkInterface); err != nil {
		return result, err
	}
	uptime, err := read("/proc/uptime")
	if err != nil {
		return result, err
	}
	if result.Metrics.UptimeSeconds, err = parseUptime(uptime); err != nil {
		return result, err
	}
	result.NodeID = c.cfg.NodeID
	result.Timestamp = time.Now().UnixMilli()
	return result, nil
}
