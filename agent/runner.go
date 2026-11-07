package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"time"
)

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

// Keep successful beacons on monotonic deadlines rather than waiting a full
// interval after the HTTP ACK. Skip elapsed slots; never send a catch-up burst.
func nextHeartbeatDeadline(previous, now time.Time, interval time.Duration) time.Time {
	next := previous.Add(interval)
	if !next.After(now) {
		next = next.Add((now.Sub(next)/interval + 1) * interval)
	}
	return next
}

func run(ctx context.Context, cfg config, collect func() (beacon, error), client *http.Client, logger *log.Logger) {
	backoff := cfg.Interval
	deadline := time.Now()
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
			// Failed attempts retain their bounded delay after the failure.
			deadline = time.Now().Add(delay)
			logger.Printf("beacon skipped/failed: %v; retry in %s", err, delay.Round(time.Millisecond))
		} else {
			logger.Printf("beacon ACK cpu=%.2f%% ram=%.2f%%", payload.Metrics.CPU.Percent, payload.Metrics.Memory.Percent)
			deadline = nextHeartbeatDeadline(deadline, time.Now(), delay)
		}
		if !wait(ctx, time.Until(deadline)) {
			return
		}
	}
}

// This is a soft budget for Go-managed memory, not a process RSS limit.
// The binary/OS mappings are additional; an explicit GOMEMLIMIT overrides it.
func configureMemoryBudget() {
	if _, configured := os.LookupEnv("GOMEMLIMIT"); !configured {
		debug.SetMemoryLimit(defaultMemoryBudget)
	}
}

func runAgent(ctx context.Context, cfg config, check bool, logger *log.Logger) error {
	collect, err := newCollector(cfg)
	if err != nil {
		return fmt.Errorf("collector initialization failed: %w", err)
	}
	client := newClient(cfg.HTTPTimeout)
	defer client.CloseIdleConnections()
	logger.Printf("started node=%s interface=%s disk=%s (%s host metrics; Go soft memory budget %d bytes)", cfg.NodeID, cfg.NetworkInterface, cfg.DiskMountPoint, runtime.GOOS, debug.SetMemoryLimit(-1))
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
