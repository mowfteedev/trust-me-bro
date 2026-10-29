package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPSRequiresTrustAndSupportsTLS12And13(t *testing.T) {
	for _, version := range []uint16{tls.VersionTLS12, tls.VersionTLS13} {
		t.Run(tls.VersionName(version), func(t *testing.T) {
			cfg := testConfig(t)
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.TLS == nil || req.TLS.Version != version || req.Header.Get("X-Node-Token") != cfg.NodeToken {
					t.Error("TLS version or node authentication changed")
				}
				_, _ = io.WriteString(w, `{"success":true}`)
			}))
			server.Config.ErrorLog = log.New(io.Discard, "", 0)
			server.TLS = &tls.Config{MinVersion: version, MaxVersion: version}
			server.StartTLS()
			defer server.Close()
			cfg.GatewayURL = server.URL
			client := newClient(3 * time.Second)
			defer client.CloseIdleConnections()
			if err := sendBeacon(context.Background(), client, cfg, fixtureBeacon()); err == nil {
				t.Fatal("accepted an untrusted HTTPS certificate")
			}
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
			if err := sendBeacon(context.Background(), client, cfg, fixtureBeacon()); err != nil {
				t.Fatalf("trusted HTTPS beacon failed: %v", err)
			}
		})
	}
}
