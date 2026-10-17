package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"syscall"
	"time"
)

func newClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		// A redirect must never forward the node token to a different endpoint.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			// Direct WireGuard connection; do not inherit HTTP_PROXY and leak the token.
			MaxIdleConns: 1, MaxIdleConnsPerHost: 1, IdleConnTimeout: 30 * time.Second,
			TLSHandshakeTimeout: timeout, ResponseHeaderTimeout: timeout,
			MaxResponseHeaderBytes: 16 * 1024, DisableCompression: true,
		},
	}
}

func sendBeacon(ctx context.Context, client *http.Client, cfg config, payload beacon) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode beacon: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.GatewayURL+"/api/telemetry/beacon", bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("create beacon request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Node-Token", cfg.NodeToken)
	req.Header.Set("User-Agent", "ZT-Mini-Agent/2.0")
	resp, err := client.Do(req)
	if err != nil {
		// No response body, URL or token in logs. Cancellation/timeout still visible.
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if timeout, ok := err.(interface{ Timeout() bool }); ok && timeout.Timeout() {
			return fmt.Errorf("beacon request timed out")
		}
		return fmt.Errorf("beacon connection failed")
	}
	defer resp.Body.Close()
	// Bound response consumption; oversized/unread bodies close the connection.
	_, readErr := io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Gateway rejected beacon (HTTP %d)", resp.StatusCode)
	}
	if readErr != nil {
		return fmt.Errorf("incomplete beacon response")
	}
	return nil
}

func nextDelay(cfg config, current time.Duration, success bool, random float64) (time.Duration, time.Duration) {
	if success {
		current = cfg.Interval
	} else {
		current = min(cfg.MaxBackoff, current*2)
	}
	jittered := time.Duration(float64(current) * (1 + (2*random-1)*cfg.Jitter))
	return current, min(cfg.MaxBackoff, max(time.Second, jittered))
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func run(ctx context.Context, cfg config, collect func() (beacon, error), client *http.Client, logger *log.Logger) {
	backoff := cfg.Interval
	for ctx.Err() == nil {
		payload, err := collect()
		if err == nil {
			err = sendBeacon(ctx, client, cfg, payload)
		}
		if ctx.Err() != nil {
			return
		}
		var delay time.Duration
		backoff, delay = nextDelay(cfg, backoff, err == nil, rand.Float64())
		if err != nil {
			logger.Printf("beacon skipped/failed: %v; retry in %s", err, delay.Round(time.Millisecond))
		} else {
			logger.Printf("beacon ACK cpu=%.2f%% ram=%.2f%%", payload.Metrics.CPU.Percent, payload.Metrics.Memory.Percent)
		}
		if !wait(ctx, delay) {
			return
		}
	}
}

// This is a soft budget for Go-managed memory, not a process RSS limit.
// The binary/OS mappings are additional; an explicit GOMEMLIMIT overrides it.
func configureMemoryBudget() {
	if _, configured := os.LookupEnv("GOMEMLIMIT"); !configured {
		debug.SetMemoryLimit(6 << 20)
	}
}

func runAgent(ctx context.Context, cfg config, check bool, logger *log.Logger) error {
	collect, err := newCollector(cfg)
	if err != nil {
		return fmt.Errorf("collector initialization failed: %w", err)
	}
	client := newClient(cfg.HTTPTimeout)
	defer client.CloseIdleConnections()
	logger.Printf("started node=%s interface=%s disk=%s (%s host metrics)", cfg.NodeID, cfg.NetworkInterface, cfg.DiskMountPoint, runtime.GOOS)
	// First CPU value needs an elapsed interval, not a fabricated warm-up zero.
	if wait(ctx, cfg.Interval) {
		if check {
			payload, err := collect.collect()
			if err != nil {
				return err
			}
			// Local diagnostic only; never includes the node token or sends HTTP.
			return json.NewEncoder(os.Stdout).Encode(payload)
		}
		run(ctx, cfg, collect.collect, client, logger)
	}
	logger.Print("stopped")
	return nil
}

func start(args []string, logger *log.Logger) error {
	flags := flag.NewFlagSet("zt-agent", flag.ContinueOnError)
	configPath := flags.String("config", "", "JSON settings file; otherwise read environment")
	service := flags.Bool("service", false, "run under Windows Service Control Manager")
	check := flags.Bool("check", false, "collect and print one real sample without sending HTTP")
	validate := flags.Bool("validate-config", false, "validate settings without collecting or connecting")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || (*service && (*check || *validate)) {
		return fmt.Errorf("unexpected arguments or incompatible service/diagnostic flags")
	}
	var cfg config
	var err error
	if *configPath == "" {
		cfg, err = loadConfig()
	} else {
		cfg, err = loadConfigFile(*configPath)
	}
	if err != nil {
		return err
	}
	if *validate {
		logger.Print("configuration valid (no collection or network request)")
		return nil
	}
	if *service {
		if *configPath == "" {
			return fmt.Errorf("Windows service requires --config")
		}
		output, err := newServiceLog(*configPath)
		if err != nil {
			return err
		}
		defer output.Close()
		logger.SetOutput(output)
		err = runPlatformService(func(ctx context.Context) error { return runAgent(ctx, cfg, false, logger) })
		if err != nil {
			logger.Print(err) // Record the cause before the service log is closed.
		}
		logger.SetOutput(os.Stderr)
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return runAgent(ctx, cfg, *check, logger)
}

func main() {
	configureMemoryBudget()
	if _, configured := os.LookupEnv("GOMAXPROCS"); !configured {
		runtime.GOMAXPROCS(1)
	}
	logger := log.New(os.Stderr, "zt-agent ", log.LstdFlags)
	if err := start(os.Args[1:], logger); err != nil {
		logger.Print(err)
		os.Exit(1)
	}
}
