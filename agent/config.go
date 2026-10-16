package main

import (
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type config struct {
	GatewayURL, NodeID, NodeToken, NetworkInterface, DiskMountPoint string
	Interval, MaxBackoff, HTTPTimeout                               time.Duration
	Jitter                                                          float64
}

func loadConfig() (config, error) {
	get := func(key, fallback string) string {
		if value, ok := os.LookupEnv(key); ok {
			return value
		}
		return fallback
	}
	cfg := config{
		GatewayURL:       strings.TrimRight(get("GATEWAY_URL", "http://10.100.0.1:3000"), "/"),
		NodeID:           get("NODE_ID", "node-worker-01"),
		NodeToken:        strings.TrimSpace(get("NODE_TOKEN", "")),
		NetworkInterface: get("NETWORK_INTERFACE", "wg0"),
		DiskMountPoint:   get("DISK_MOUNT_POINT", "/"),
	}
	u, err := url.Parse(cfg.GatewayURL)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(cfg.GatewayURL, "#") {
		return cfg, fmt.Errorf("GATEWAY_URL must be an absolute HTTP(S) URL without credentials, query or fragment")
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9_-]{3,64}$`).MatchString(cfg.NodeID) {
		return cfg, fmt.Errorf("NODE_ID must match [a-zA-Z0-9_-]{3,64}")
	}
	if len(cfg.NodeToken) == 0 || len(cfg.NodeToken) > 512 || strings.IndexFunc(cfg.NodeToken, func(r rune) bool { return r < 33 || r > 126 }) >= 0 {
		return cfg, fmt.Errorf("NODE_TOKEN is required (1–512 printable ASCII characters without whitespace)")
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,15}$`).MatchString(cfg.NetworkInterface) {
		return cfg, fmt.Errorf("NETWORK_INTERFACE must name one Linux interface")
	}
	if !filepath.IsAbs(cfg.DiskMountPoint) || strings.ContainsAny(cfg.DiskMountPoint, "\x00\r\n") {
		return cfg, fmt.Errorf("DISK_MOUNT_POINT must be an absolute Linux path")
	}
	seconds := func(key, fallback string, min, max float64) (time.Duration, error) {
		value, err := strconv.ParseFloat(get(key, fallback), 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < min || value > max {
			return 0, fmt.Errorf("%s must be a finite number in [%g, %g] seconds", key, min, max)
		}
		return time.Duration(value * float64(time.Second)), nil
	}
	if cfg.Interval, err = seconds("BEACON_INTERVAL_SECONDS", "3.0", 1, 60); err != nil {
		return cfg, err
	}
	if cfg.MaxBackoff, err = seconds("MAX_BACKOFF_SECONDS", "30.0", cfg.Interval.Seconds(), 300); err != nil {
		return cfg, err
	}
	if cfg.HTTPTimeout, err = seconds("HTTP_TIMEOUT_SECONDS", "3.0", 0.1, 30); err != nil {
		return cfg, err
	}
	cfg.Jitter, err = strconv.ParseFloat(get("JITTER_RATIO", "0.1"), 64)
	if err != nil || math.IsNaN(cfg.Jitter) || math.IsInf(cfg.Jitter, 0) || cfg.Jitter < 0 || cfg.Jitter > 0.5 {
		return cfg, fmt.Errorf("JITTER_RATIO must be a finite number in [0, 0.5]")
	}
	return cfg, nil
}
