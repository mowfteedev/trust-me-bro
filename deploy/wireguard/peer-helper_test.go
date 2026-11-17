package main

import (
	"encoding/base64"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func publicKey(value byte) string {
	return base64.StdEncoding.EncodeToString([]byte(strings.Repeat(string([]byte{value}), 32)))
}

func TestRequestValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request")
	good := publicKey(1) + "\n10.100.0.3\n"
	for _, body := range []string{good, strings.TrimSuffix(good, "\n")} {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		key, ip, canonical, err := readRequest(path)
		if err != nil || key != publicKey(1) || ip.String() != "10.100.0.3" || string(canonical) != good {
			t.Fatalf("valid request rejected: %v", err)
		}
	}
	for _, body := range []string{publicKey(1) + "\n10.100.0.1\n", publicKey(1) + "\n10.100.0.2\n", publicKey(1) + "\n10.100.0.255\n", publicKey(1) + "\n10.100.1.3\n", publicKey(1) + "\n10.100.0.3/32\n", publicKey(1) + "\n10.100.0.3\nextra", publicKey(0) + "\n10.100.0.3\n", "wrong\n10.100.0.3\n", strings.Repeat("a", 129)} {
		os.WriteFile(path, []byte(body), 0600)
		if _, _, _, err := readRequest(path); err == nil {
			t.Error("unsafe request accepted")
		}
	}
	os.Remove(path)
	target := filepath.Join(t.TempDir(), "target")
	os.WriteFile(target, []byte(good), 0600)
	os.Symlink(target, path)
	if _, _, _, err := readRequest(path); err == nil {
		t.Error("symlink accepted")
	}
	os.Remove(path)
	os.Mkdir(path, 0700)
	if _, _, _, err := readRequest(path); err == nil {
		t.Error("directory accepted")
	}
}

func TestExistingPeerProtection(t *testing.T) {
	key, other, ip := publicKey(1), publicKey(2), netip.MustParseAddr("10.100.0.3")
	if exists, err := validatePeers(other+"\t10.100.0.2/32\n", key, ip); err != nil || exists {
		t.Fatal("nonoverlapping peer rejected")
	}
	if exists, err := validatePeers(key+"\t10.100.0.3/32\n", key, ip); err != nil || !exists {
		t.Fatal("idempotent peer rejected")
	}
	for _, existing := range []string{key + "\t10.100.0.4/32", key + "\t10.100.0.3/32,10.100.0.4/32", other + "\t10.100.0.3/32", other + "\t10.100.0.0/24", other + "\t0.0.0.0/0", other + "\twrong"} {
		if _, err := validatePeers(existing, key, ip); err == nil {
			t.Error("conflicting peer accepted")
		}
	}
	if _, err := validatePeers(other+"\t::/0", key, ip); err != nil {
		t.Fatal("unrelated IPv6 route rejected")
	}
}

func TestFilenameAndDirectoryGuards(t *testing.T) {
	for _, s := range []string{"../../escape.peer", "x.peer", "12345678-1234-1234-1234-123456789abc.peer/next"} {
		if identifier.MatchString(s) {
			t.Error("invalid filename")
		}
	}
	if !identifier.MatchString("12345678-1234-1234-1234-123456789abc.peer") {
		t.Error("UUID filename rejected")
	}
	dir := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	os.Symlink(dir, link)
	if safeDirectory(link, false) {
		t.Error("symlink directory accepted")
	}
	if !safeDirectory(dir, false) {
		t.Error("real directory rejected")
	}
	if err := os.WriteFile(filepath.Join(dir, "123.ready"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(dir, "123.ready"))
	os.Symlink("/tmp/never-write", filepath.Join(dir, "123.ready"))
	if acknowledge(dir, "123.peer", []byte("new")) == nil {
		t.Error("ack symlink accepted")
	}
}
