//go:build linux

package main

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

const defaultNodeID = "node-worker-01"
const defaultNetworkInterface = "wg0"
const defaultDiskMountPoint = "/"

func validatePlatformConfig(cfg config) error {
	if !regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,15}$`).MatchString(cfg.NetworkInterface) {
		return fmt.Errorf("NETWORK_INTERFACE must name one Linux interface")
	}
	if !filepath.IsAbs(cfg.DiskMountPoint) || strings.ContainsAny(cfg.DiskMountPoint, "\x00\r\n") {
		return fmt.Errorf("DISK_MOUNT_POINT must be an absolute Linux path")
	}
	return nil
}

func runPlatformService(_ func(context.Context) error) error {
	return fmt.Errorf("--service is for Windows; Linux uses systemd or Docker")
}
