package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestHeartbeatDeadlineSubtractsElapsedAndSkipsMissedSlots(t *testing.T) {
	start := time.Now()
	for _, tc := range []struct {
		name    string
		elapsed time.Duration
		want    time.Duration
	}{
		{"ACK takes 300ms", 300 * time.Millisecond, 3 * time.Second},
		{"one elapsed slot", 3300 * time.Millisecond, 6 * time.Second},
		{"several elapsed slots", 9400 * time.Millisecond, 12 * time.Second},
		{"completed at deadline", 3 * time.Second, 6 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := start.Add(tc.elapsed)
			next := nextHeartbeatDeadline(start, now, 3*time.Second)
			if next.Sub(start) != tc.want || !next.After(now) {
				t.Fatalf("next=%s elapsed=%s want=%s", next.Sub(start), tc.elapsed, tc.want)
			}
		})
	}
}

func TestRunDelayedACKDoesNotAddToHealthyCadence(t *testing.T) {
	cfg := testConfig(t)
	cfg.Interval, cfg.MaxBackoff, cfg.Jitter = time.Second, 4*time.Second, 0
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// Real delayed HTTP ACK, independent from the scheduling implementation.
		timer := time.NewTimer(600 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-req.Context().Done():
			return
		case <-timer.C:
			_, _ = io.WriteString(w, `{"success":true}`)
		}
	}))
	defer server.Close()
	cfg.GatewayURL = server.URL
	client := newClient(2 * time.Second)
	defer client.CloseIdleConnections()
	var starts []time.Time
	run(ctx, cfg, func() (beacon, error) {
		starts = append(starts, time.Now())
		if len(starts) == 5 {
			cancel()
		}
		return fixtureBeacon(), nil
	}, client, log.New(io.Discard, "", 0))
	if len(starts) != 5 {
		t.Fatalf("got %d collections, want5", len(starts))
	}
	elapsed := starts[4].Sub(starts[0])
	// Four 1s slots must not become four(1s+600ms) ACK/delay cycles.
	if elapsed < 3700*time.Millisecond || elapsed > 4500*time.Millisecond {
		t.Fatalf("four healthy intervals took %s; ACK duration accumulated or sends burst", elapsed)
	}
	for i := 1; i < len(starts); i++ {
		if gap := starts[i].Sub(starts[i-1]); gap < 800*time.Millisecond {
			t.Fatalf("catch-up burst: interval %d took %s", i, gap)
		}
	}
}

func TestRunSlowACKSkipsSlotsWithoutOverlappingRequests(t *testing.T) {
	cfg := testConfig(t)
	cfg.Interval, cfg.MaxBackoff, cfg.Jitter = time.Second, 4*time.Second, 0
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var active, maximum atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		count := active.Add(1)
		defer active.Add(-1)
		for current := maximum.Load(); count > current; current = maximum.Load() {
			if maximum.CompareAndSwap(current, count) {
				break
			}
		}
		timer := time.NewTimer(1200 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-req.Context().Done():
			return
		case <-timer.C:
			_, _ = io.WriteString(w, `{"success":true}`)
		}
	}))
	defer server.Close()
	cfg.GatewayURL = server.URL
	client := newClient(2 * time.Second)
	defer client.CloseIdleConnections()
	var starts []time.Time
	run(ctx, cfg, func() (beacon, error) {
		starts = append(starts, time.Now())
		if len(starts) == 3 {
			cancel()
		}
		return fixtureBeacon(), nil
	}, client, log.New(io.Discard, "", 0))
	if len(starts) != 3 {
		t.Fatalf("got %d collections, want3", len(starts))
	}
	if maximum.Load() != 1 {
		t.Fatalf("overlapping requests: maximum=%d", maximum.Load())
	}
	for i := 1; i < len(starts); i++ {
		if gap := starts[i].Sub(starts[i-1]); gap < 1800*time.Millisecond || gap > 2300*time.Millisecond {
			t.Fatalf("slow ACK did not skip the occupied slot: gap=%s", gap)
		}
	}
}
