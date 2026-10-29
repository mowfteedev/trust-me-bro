package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	response, readErr := io.ReadAll(io.LimitReader(resp.Body, 4097))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Gateway rejected beacon (HTTP %d)", resp.StatusCode)
	}
	if readErr != nil {
		return fmt.Errorf("incomplete beacon response")
	}
	var ack struct {
		Success bool `json:"success"`
	}
	if len(response) > 4096 || json.Unmarshal(response, &ack) != nil || !ack.Success {
		return fmt.Errorf("invalid beacon acknowledgement")
	}
	return nil
}
