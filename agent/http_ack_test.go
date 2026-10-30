package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPRequiresSuccessfulAcknowledgement(t *testing.T) {
	for _, body := range []string{"", "<html>dashboard</html>", `{}`, `{"success":false}`, `{"success":true} trailing`, `{"success":true,"extra":"` + strings.Repeat("x", 4096) + `"}`} {
		t.Run(body[:min(24, len(body))], func(t *testing.T) {
			cfg := testConfig(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, body)
			}))
			defer server.Close()
			cfg.GatewayURL = server.URL
			client := newClient(time.Second)
			defer client.CloseIdleConnections()
			if err := sendBeacon(context.Background(), client, cfg, fixtureBeacon()); err == nil {
				t.Fatal("reported ACK for an invalid HTTP 200 response")
			}
		})
	}
}
