//go:build windows && go1.24

package main

import (
	"crypto/fips140"
	"testing"
)

func TestWindowsCryptoDefault(t *testing.T) {
	if fips140.Enabled() {
		t.Fatal("the Windows build unexpectedly enabled FIPS mode")
	}
}
