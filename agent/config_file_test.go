package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigFileIsBoundedStrictAndIndependentOfEnvironment(t *testing.T) {
	t.Setenv("NODE_TOKEN", "ambient-secret-must-not-win")
	t.Setenv("GATEWAY_URL", "http://ambient.invalid")
	path := filepath.Join(t.TempDir(), "config.json")
	values := map[string]string{"NODE_TOKEN": "file-token", "DISK_MOUNT_POINT": defaultDiskMountPoint}
	data, _ := json.Marshal(values)
	if err := os.WriteFile(path, append([]byte{0xef, 0xbb, 0xbf}, data...), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfigFile(path)
	if err != nil || cfg.NodeToken != "file-token" || cfg.GatewayURL != "http://10.100.0.1:3000" || cfg.NetworkInterface != defaultNetworkInterface {
		t.Fatalf("file settings/defaults: %+v %v", cfg, err)
	}
	for _, invalid := range []string{
		`{"NODE_TOKEN":"file-token","UNKNOWN":"secret"}`, `{"NODE_TOKEN":42}`, `{"NODE_TOKEN":"secret"} trailing`, `null`, `{}`, strings.Repeat("x", 16385),
	} {
		if err := os.WriteFile(path, []byte(invalid), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := loadConfigFile(path)
		if err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "file-token") {
			t.Fatalf("invalid config accepted or exposed input: %v", err)
		}
	}
	if _, err := loadConfigFile(path + ".missing"); err == nil {
		t.Fatal("missing file accepted")
	}
}

func TestCPUJSONOmitsUnavailableLoadAverage(t *testing.T) {
	data, err := json.Marshal(cpuMetric{Percent: 25})
	if err != nil || bytes.Contains(data, []byte("load_avg")) {
		t.Fatalf("unavailable load average was fabricated: %s %v", data, err)
	}
	data, err = json.Marshal(cpuMetric{Percent: 25, LoadAvg: &[3]float64{1, 2, 3}})
	if err != nil || !bytes.Contains(data, []byte(`"load_avg":[1,2,3]`)) {
		t.Fatalf("Linux contract lost load average: %s %v", data, err)
	}
}

func TestCapacityUsesMatchingTotalAndAvailableCounters(t *testing.T) {
	// A quota-limited account can have total=400, available=100 while the
	// physical volume has 800 bytes free. Only the first two counters match.
	metric, err := capacityFromAvailable(400, 100)
	if err != nil || metric.TotalBytes != 400 || metric.UsedBytes != 300 || metric.Percent != 75 {
		t.Fatalf("quota-relative capacity: %+v %v", metric, err)
	}
	for _, counters := range [][2]uint64{{0, 0}, {400, 800}} {
		if _, err := capacityFromAvailable(counters[0], counters[1]); err == nil {
			t.Fatal("accepted inconsistent capacity counters")
		}
	}
}

func TestServiceLogRotatesWithoutGrowingUnbounded(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "logs"), 0700); err != nil {
		t.Fatal(err)
	}
	writer, err := newServiceLog(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	line := []byte(strings.Repeat("x", 1024))
	for range 1030 {
		if _, err := writer.Write(line); err != nil {
			t.Fatal(err)
		}
	}
	current, err := os.Stat(filepath.Join(dir, "logs", "agent.log"))
	if err != nil || current.Size() != 6*1024 {
		t.Fatalf("current log: %v %v", current, err)
	}
	previous, err := os.Stat(filepath.Join(dir, "logs", "agent.log.1"))
	if err != nil || previous.Size() != 1<<20 {
		t.Fatalf("rotated log: %v %v", previous, err)
	}
}
