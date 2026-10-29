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
	"reflect"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
	"time"
)

func testConfig(t *testing.T) config {
	t.Helper()
	for key, value := range map[string]string{
		"GATEWAY_URL": "http://10.100.0.1:3000", "NODE_ID": "node-worker-01", "NODE_TOKEN": "test-token",
		"NETWORK_INTERFACE": "wg0", "DISK_MOUNT_POINT": defaultDiskMountPoint, "BEACON_INTERVAL_SECONDS": "3.0",
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
		{"NETWORK_INTERFACE", "wg0\neth0"}, {"DISK_MOUNT_POINT", "relative"},
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

func fixtureBeacon() beacon {
	return beacon{NodeID: "node-worker-01", Timestamp: 1700000000000, Metrics: metrics{
		CPU:    cpuMetric{Percent: 12.5, LoadAvg: &[3]float64{1, 2, 3}},
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
		if err := json.NewDecoder(req.Body).Decode(&payload); err != nil || !reflect.DeepEqual(payload, fixtureBeacon()) {
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
	if err := sendBeacon(context.Background(), client, cfg, fixtureBeacon()); err == nil || !strings.Contains(err.Error(), "acknowledgement") {
		t.Fatalf("oversized response was not rejected within the read bound: %v", err)
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
	expected := int64(6 << 20)
	if runtime.GOOS == "windows" {
		expected = 2 << 20
	}
	if got := debug.SetMemoryLimit(-1); got != expected {
		t.Fatalf("default managed-memory budget = %d, want %d", got, expected)
	}
	t.Setenv("GOMEMLIMIT", "12MiB")
	debug.SetMemoryLimit(12 << 20) // Simulate the runtime's startup env setting.
	configureMemoryBudget()
	if got := debug.SetMemoryLimit(-1); got != 12<<20 {
		t.Fatalf("explicit memory budget was overwritten: %d", got)
	}
}
