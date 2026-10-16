package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime/debug"
	"strings"
	"testing"
	"time"
)

func testConfig(t *testing.T) config {
	t.Helper()
	for key, value := range map[string]string{
		"GATEWAY_URL": "http://10.100.0.1:3000", "NODE_ID": "node-worker-01", "NODE_TOKEN": "test-token",
		"NETWORK_INTERFACE": "wg0", "DISK_MOUNT_POINT": "/", "BEACON_INTERVAL_SECONDS": "3.0",
		"MAX_BACKOFF_SECONDS": "30.0", "HTTP_TIMEOUT_SECONDS": "3.0", "JITTER_RATIO": "0.1",
	} {
		t.Setenv(key, value)
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestConfig(t *testing.T) {
	cfg := testConfig(t)
	if cfg.Interval != 3*time.Second || cfg.MaxBackoff != 30*time.Second || cfg.HTTPTimeout != 3*time.Second || cfg.NetworkInterface != "wg0" {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
	for _, tc := range []struct{ key, value string }{
		{"NODE_TOKEN", ""}, {"NODE_TOKEN", "token\r\nsecret"}, {"NODE_ID", "ab"}, {"NODE_ID", "node\nworker"}, {"NODE_ID", "node worker"}, {"NODE_ID", "máy-chủ"}, {"NODE_ID", "node.worker"},
		{"GATEWAY_URL", "ftp://host"}, {"GATEWAY_URL", "http://user:secret@host"}, {"GATEWAY_URL", "http://host?token=secret"}, {"GATEWAY_URL", "http://host?"}, {"GATEWAY_URL", "http://host#"},
		{"NETWORK_INTERFACE", "wg0,eth0"}, {"DISK_MOUNT_POINT", "relative"},
		{"BEACON_INTERVAL_SECONDS", "0"}, {"BEACON_INTERVAL_SECONDS", "NaN"},
		{"MAX_BACKOFF_SECONDS", "2"}, {"MAX_BACKOFF_SECONDS", "Inf"},
		{"HTTP_TIMEOUT_SECONDS", "0"}, {"JITTER_RATIO", "-0.1"}, {"JITTER_RATIO", "NaN"},
	} {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			t.Setenv(tc.key, tc.value)
			if _, err := loadConfig(); err == nil {
				t.Fatalf("accepted invalid %s", tc.key)
			}
		})
	}
}

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

func fixtureBeacon() beacon {
	return beacon{NodeID: "node-worker-01", Timestamp: 1700000000000, Metrics: metrics{
		CPU:    cpuMetric{Percent: 12.5, LoadAvg: [3]float64{1, 2, 3}},
		Memory: capacityMetric{1024, 512, 50}, Disk: capacityMetric{2048, 1024, 50},
		Network: networkMetric{123, 456}, UptimeSeconds: 100,
	}}
}

func TestHTTPContract(t *testing.T) {
	cfg := testConfig(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != "POST" || req.URL.Path != "/api/telemetry/beacon" || req.Header.Get("X-Node-Token") != cfg.NodeToken || req.Header.Get("Content-Type") != "application/json" {
			t.Errorf("bad beacon request: method=%s path=%s", req.Method, req.URL.Path)
		}
		var payload beacon
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil || payload != fixtureBeacon() {
			t.Errorf("bad JSON contract: %+v (%v)", payload, err)
		}
		_, _ = io.WriteString(w, `{"success":true}`)
	}))
	defer server.Close()
	cfg.GatewayURL = server.URL
	client := newClient(time.Second)
	defer client.CloseIdleConnections()
	if err := sendBeacon(context.Background(), client, cfg, fixtureBeacon()); err != nil {
		t.Fatal(err)
	}
}

func TestHTTPRejectsErrorsAndRedirects(t *testing.T) {
	cfg := testConfig(t)
	targetCalled := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalled = true }))
	defer target.Close()
	for _, status := range []int{201, 302, 401, 429, 500} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", target.URL)
			w.WriteHeader(status)
			_, _ = io.WriteString(w, "secret response must never be logged")
		}))
		cfg.GatewayURL = server.URL
		client := newClient(time.Second)
		err := sendBeacon(context.Background(), client, cfg, fixtureBeacon())
		client.CloseIdleConnections()
		server.Close()
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("HTTP %d: %v", status, err)
		}
	}
	if targetCalled {
		t.Fatal("redirect forwarded node token")
	}
	client := newClient(time.Second)
	defer client.CloseIdleConnections()
	if client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("VPN client must not inherit ambient proxy")
	}
}

func TestHTTPTimeoutAndCancellation(t *testing.T) {
	cfg := testConfig(t)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { <-release }))
	defer func() { close(release); server.Close() }()
	cfg.GatewayURL = server.URL
	client := newClient(30 * time.Millisecond)
	defer client.CloseIdleConnections()
	if err := sendBeacon(context.Background(), client, cfg, fixtureBeacon()); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected bounded timeout, got %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := sendBeacon(ctx, client, cfg, fixtureBeacon()); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled request: %v", err)
	}
}

func TestResponseReadIsBounded(t *testing.T) {
	cfg := testConfig(t)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("x", 8192))
		w.(http.Flusher).Flush()
		// Leave the body open: the agent must finish after its bounded 4 KiB read.
		<-release
	}))
	defer func() { close(release); server.Close() }()
	cfg.GatewayURL = server.URL
	client := newClient(time.Second)
	defer client.CloseIdleConnections()
	if err := sendBeacon(context.Background(), client, cfg, fixtureBeacon()); err != nil {
		t.Fatalf("read unbounded response: %v", err)
	}
}

func TestBackoffResetCapAndJitter(t *testing.T) {
	cfg := testConfig(t)
	current := cfg.Interval
	for _, expected := range []time.Duration{6, 12, 24, 30, 30} {
		var delay time.Duration
		current, delay = nextDelay(cfg, current, false, 0.5)
		if current != expected*time.Second || delay != current {
			t.Fatalf("unexpected backoff current=%s delay=%s", current, delay)
		}
	}
	current, delay := nextDelay(cfg, current, true, 0)
	if current != 3*time.Second || delay != 2700*time.Millisecond {
		t.Fatalf("success did not reset with jitter: %s/%s", current, delay)
	}
	_, delay = nextDelay(cfg, cfg.MaxBackoff, false, 1)
	if delay > cfg.MaxBackoff {
		t.Fatal("jitter exceeded maximum retry delay")
	}
}

func TestRunRetriesAndStopsWithoutWaitingForBackoff(t *testing.T) {
	cfg := testConfig(t)
	cfg.Interval, cfg.MaxBackoff, cfg.Jitter = time.Millisecond, time.Second, 0
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(503)
			return
		}
		cancel() // A second real HTTP request proves automatic retry.
	}))
	defer server.Close()
	cfg.GatewayURL = server.URL
	client := newClient(time.Second)
	defer client.CloseIdleConnections()
	run(ctx, cfg, func() (beacon, error) { return fixtureBeacon(), nil }, client, log.New(io.Discard, "", 0))
	if calls != 2 {
		t.Fatalf("expected failure then retry, got %d calls", calls)
	}
}

func TestCollectorErrorNeverSendsFakeHeartbeat(t *testing.T) {
	cfg := testConfig(t)
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { called = true }))
	defer server.Close()
	cfg.GatewayURL = server.URL
	ctx, cancel := context.WithCancel(context.Background())
	client := newClient(time.Second)
	defer client.CloseIdleConnections()
	run(ctx, cfg, func() (beacon, error) { cancel(); return beacon{}, os.ErrNotExist }, client, log.New(io.Discard, "", 0))
	if called {
		t.Fatal("collection failure was sent as a successful heartbeat")
	}
}

func TestCancelledWaitReturnsImmediately(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if wait(ctx, time.Hour) {
		t.Fatal("cancelled backoff did not stop")
	}
}

func TestMemoryBudgetDefaultAndOverride(t *testing.T) {
	previous := debug.SetMemoryLimit(-1)
	defer debug.SetMemoryLimit(previous)
	t.Setenv("GOMEMLIMIT", "") // Register restoration of the original environment.
	if err := os.Unsetenv("GOMEMLIMIT"); err != nil {
		t.Fatal(err)
	}
	configureMemoryBudget()
	if got := debug.SetMemoryLimit(-1); got != 6<<20 {
		t.Fatalf("default managed-memory budget = %d, want 6 MiB", got)
	}
	t.Setenv("GOMEMLIMIT", "12MiB")
	debug.SetMemoryLimit(12 << 20) // Simulate the runtime's startup env setting.
	configureMemoryBudget()
	if got := debug.SetMemoryLimit(-1); got != 12<<20 {
		t.Fatalf("explicit memory budget was overwritten: %d", got)
	}
}
