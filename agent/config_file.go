package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// Service settings contain the same string keys as the environment contract.
// A config file is self-contained: ambient NODE_TOKEN/URL values cannot override it.
func loadConfigFile(path string) (config, error) {
	file, err := os.Open(path)
	if err != nil {
		return config{}, fmt.Errorf("cannot open config file")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 16*1024+1))
	if err != nil || len(data) > 16*1024 {
		return config{}, fmt.Errorf("config file must be readable and at most 16 KiB")
	}
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}) // Windows PowerShell UTF-8 BOM.
	var values map[string]string
	if err := json.Unmarshal(data, &values); err != nil || values == nil {
		return config{}, fmt.Errorf("config file must be a JSON object of string settings")
	}
	for key := range values {
		switch key {
		case "GATEWAY_URL", "NODE_ID", "NODE_TOKEN", "NETWORK_INTERFACE", "DISK_MOUNT_POINT",
			"BEACON_INTERVAL_SECONDS", "MAX_BACKOFF_SECONDS", "HTTP_TIMEOUT_SECONDS", "JITTER_RATIO":
		default:
			return config{}, fmt.Errorf("config file contains an unsupported setting")
		}
	}
	return parseConfig(func(key, fallback string) string {
		if value, ok := values[key]; ok {
			return value
		}
		return fallback
	})
}
