package main

import (
	"fmt"
	"math"
)

type cpuMetric struct {
	Percent float64     `json:"percent"`
	LoadAvg *[3]float64 `json:"load_avg,omitempty"`
}
type capacityMetric struct {
	TotalBytes uint64  `json:"total_bytes"`
	UsedBytes  uint64  `json:"used_bytes"`
	Percent    float64 `json:"percent"`
}
type networkMetric struct {
	RXBytesTotal uint64 `json:"rx_bytes_total"`
	TXBytesTotal uint64 `json:"tx_bytes_total"`
}
type metrics struct {
	CPU           cpuMetric      `json:"cpu"`
	Memory        capacityMetric `json:"memory"`
	Disk          capacityMetric `json:"disk"`
	Network       networkMetric  `json:"network"`
	UptimeSeconds uint64         `json:"uptime_seconds"`
}
type beacon struct {
	NodeID    string  `json:"node_id"`
	Timestamp int64   `json:"timestamp"`
	Metrics   metrics `json:"metrics"`
}
type cpuTimes struct{ idle, total uint64 }

func cpuPercent(previous, current cpuTimes) (float64, error) {
	if current.total <= previous.total || current.idle < previous.idle || current.idle-previous.idle > current.total-previous.total {
		return 0, fmt.Errorf("CPU counters reset or sample interval too short")
	}
	return roundPercent(100 * (1 - float64(current.idle-previous.idle)/float64(current.total-previous.total))), nil
}

func capacity(total, used uint64) capacityMetric {
	return capacityMetric{TotalBytes: total, UsedBytes: used, Percent: roundPercent(100 * float64(used) / float64(total))}
}

func capacityFromAvailable(total, available uint64) (capacityMetric, error) {
	if total == 0 || available > total {
		return capacityMetric{}, fmt.Errorf("invalid total/available capacity counters")
	}
	return capacity(total, total-available), nil
}

func roundPercent(value float64) float64 { return math.Round(value*100) / 100 }
