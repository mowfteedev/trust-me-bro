package main

import (
	"encoding/base64"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func publicKey(value byte) string {
	return base64.StdEncoding.EncodeToString([]byte(strings.Repeat(string([]byte{value}), 32)))
}

func setupFakeWg(t *testing.T) (string, string, string) {
	dir := t.TempDir()
	peersFile := filepath.Join(dir, "peers.txt")
	failFile := filepath.Join(dir, "fail_remove")
	scriptPath := filepath.Join(dir, "fake_wg.sh")
	script := fmt.Sprintf(`#!/bin/sh
PEERS="%s"
FAIL_FILE="%s"
touch "$PEERS"

if [ "$1" = "show" ] && [ "$2" = "wg0" ] && [ "$3" = "allowed-ips" ]; then
    cat "$PEERS"
    exit 0
fi

if [ "$1" = "set" ] && [ "$2" = "wg0" ] && [ "$3" = "peer" ]; then
    KEY="$4"
    ACTION="$5"
    if [ "$ACTION" = "remove" ]; then
        if [ -f "$FAIL_FILE" ]; then
            echo "simulated remove failure" >&2
            exit 1
        fi
        grep -v "^$KEY" "$PEERS" > "$PEERS.tmp" 2>/dev/null || true
        mv "$PEERS.tmp" "$PEERS"
        exit 0
    fi
    if [ "$ACTION" = "allowed-ips" ]; then
        IP="$6"
        grep -v "^$KEY" "$PEERS" > "$PEERS.tmp" 2>/dev/null || true
        printf "%%s\t%%s\n" "$KEY" "$IP" >> "$PEERS.tmp"
        mv "$PEERS.tmp" "$PEERS"
        exit 0
    fi
fi

echo "unknown command: $*" >&2
exit 1
`, peersFile, failFile)

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	return scriptPath, peersFile, failFile
}

func TestRequestValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request")
	good := publicKey(1) + "\n10.100.0.3\n"
	if err := os.WriteFile(path, []byte(good), 0600); err != nil {
		t.Fatal(err)
	}
	key, ip, canonical, err := readRequest(path)
	if err != nil || key != publicKey(1) || ip.String() != "10.100.0.3" || string(canonical) != good {
		t.Fatalf("valid request rejected: %v", err)
	}

	for _, body := range []string{
		strings.TrimSuffix(good, "\n"),
		publicKey(1) + "\n10.100.0.1\n",
		publicKey(1) + "\n10.100.0.2\n",
		publicKey(1) + "\n10.100.0.255\n",
		publicKey(1) + "\n10.100.1.3\n",
		publicKey(1) + "\n10.100.0.3/32\n",
		publicKey(1) + "\n10.100.0.3\nextra",
		publicKey(0) + "\n10.100.0.3\n",
		"wrong\n10.100.0.3\n",
		strings.Repeat("a", 129),
	} {
		os.WriteFile(path, []byte(body), 0600)
		if _, _, _, err := readRequest(path); err == nil {
			t.Errorf("unsafe request accepted: %q", body)
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

func TestRemoveRequestValidation(t *testing.T) {
	dir := t.TempDir()
	opID := "11111111-2222-3333-4444-555555555555"
	nodeID := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	invID := "99999999-8888-7777-6666-555555555555"
	goodKey := publicKey(1)
	goodIP := "10.100.0.5"

	goodContent := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, goodKey, goodIP)
	path := filepath.Join(dir, opID+".remove")

	if err := os.WriteFile(path, []byte(goodContent), 0600); err != nil {
		t.Fatal(err)
	}
	req, err := readRemoveRequest(path)
	if err != nil {
		t.Fatalf("valid remove request rejected: %v", err)
	}
	if req.OperationID != opID || req.NodeID != nodeID || req.InvitationID != invID ||
		req.PublicKey != goodKey || req.IP.String() != goodIP || string(req.CanonicalBytes) != goodContent {
		t.Fatalf("unexpected parsed remove request: %+v", req)
	}

	wrongPath := filepath.Join(dir, "22222222-2222-3333-4444-555555555555.remove")
	os.WriteFile(wrongPath, []byte(goodContent), 0600)
	if _, err := readRemoveRequest(wrongPath); err == nil {
		t.Error("operation UUID mismatch with filename accepted")
	}

	cases := []struct {
		name    string
		content string
	}{
		{"missing newline", strings.TrimSuffix(goodContent, "\n")},
		{"crlf newline", strings.ReplaceAll(goodContent, "\n", "\r\n")},
		{"wrong version", fmt.Sprintf("2\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, goodKey, goodIP)},
		{"bad op UUID", fmt.Sprintf("1\nINVALID-UUID\n%s\n%s\n%s\n%s\n", nodeID, invID, goodKey, goodIP)},
		{"bad node UUID", fmt.Sprintf("1\n%s\nINVALID-UUID\n%s\n%s\n%s\n", opID, invID, goodKey, goodIP)},
		{"bad inv UUID", fmt.Sprintf("1\n%s\n%s\nINVALID-UUID\n%s\n%s\n", opID, nodeID, goodKey, goodIP)},
		{"zero key", fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, publicKey(0), goodIP)},
		{"gateway IP", fmt.Sprintf("1\n%s\n%s\n%s\n%s\n10.100.0.1\n", opID, nodeID, invID, goodKey)},
		{"broadcast IP", fmt.Sprintf("1\n%s\n%s\n%s\n%s\n10.100.0.255\n", opID, nodeID, invID, goodKey)},
		{"wrong lines", fmt.Sprintf("1\n%s\n%s\n", opID, nodeID)},
		{"oversize", strings.Repeat("a", 513)},
	}
	for _, tc := range cases {
		p := filepath.Join(dir, opID+".remove")
		os.WriteFile(p, []byte(tc.content), 0600)
		if _, err := readRemoveRequest(p); err == nil {
			t.Errorf("case %s: invalid remove request unexpectedly accepted", tc.name)
		}
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
	for _, existing := range []string{
		key + "\t10.100.0.4/32",
		key + "\t10.100.0.3/32,10.100.0.4/32",
		other + "\t10.100.0.3/32",
		other + "\t10.100.0.0/24",
		other + "\t0.0.0.0/0",
		other + "\twrong",
	} {
		if _, err := validatePeers(existing, key, ip); err == nil {
			t.Error("conflicting peer accepted")
		}
	}
	if _, err := validatePeers(other+"\t::/0", key, ip); err != nil {
		t.Fatal("unrelated IPv6 route rejected")
	}
}

func TestRemovalBeforeAddAndDenylist(t *testing.T) {
	enforceRootOwner = false
	fakeWg, peersFile, _ := setupFakeWg(t)
	oldWg := wgExecutable
	wgExecutable = fakeWg
	defer func() {
		wgExecutable = oldWg
		enforceRootOwner = true
	}()

	reqDir := t.TempDir()
	ackDir := t.TempDir()

	opID := "11111111-1111-1111-1111-111111111111"
	nodeID := "22222222-2222-2222-2222-222222222222"
	invID := "33333333-3333-3333-3333-333333333333"
	key1 := publicKey(1)
	ip1 := "10.100.0.10"

	os.WriteFile(peersFile, []byte(fmt.Sprintf("%s\t%s/32\n", key1, ip1)), 0600)

	removeContent := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, key1, ip1)
	os.WriteFile(filepath.Join(reqDir, opID+".remove"), []byte(removeContent), 0600)

	addReqName := "44444444-4444-4444-4444-444444444444.peer"
	os.WriteFile(filepath.Join(reqDir, addReqName), []byte(fmt.Sprintf("%s\n%s\n", key1, ip1)), 0600)

	cycle(reqDir, ackDir)

	peersData, _ := os.ReadFile(peersFile)
	if strings.Contains(string(peersData), key1) {
		t.Fatal("key1 was not removed from wg0")
	}

	ackData, err := os.ReadFile(filepath.Join(ackDir, opID+".removed"))
	if err != nil {
		t.Fatalf("expected .removed ack not found: %v", err)
	}
	if string(ackData) != removeContent {
		t.Fatalf("expected ack content %q, got %q", removeContent, string(ackData))
	}

	errData, err := os.ReadFile(filepath.Join(ackDir, "44444444-4444-4444-4444-444444444444.error"))
	if err != nil {
		t.Fatalf("expected error file for revoked peer not found: %v", err)
	}
	if strings.TrimSpace(string(errData)) != "PEER_REVOKED" {
		t.Fatalf("expected PEER_REVOKED, got %q", string(errData))
	}
	if _, err := os.Stat(filepath.Join(ackDir, "44444444-4444-4444-4444-444444444444.ready")); err == nil {
		t.Fatal(".ready file should not exist for revoked peer")
	}
}

func TestRestartWithDeletedRemoveRequestAndRootAckPersists(t *testing.T) {
	enforceRootOwner = false
	fakeWg, peersFile, _ := setupFakeWg(t)
	oldWg := wgExecutable
	wgExecutable = fakeWg
	defer func() {
		wgExecutable = oldWg
		enforceRootOwner = true
	}()

	reqDir := t.TempDir()
	ackDir := t.TempDir()

	opID := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	nodeID := "11111111-2222-3333-4444-555555555555"
	invID := "55555555-4444-3333-2222-111111111111"
	keyOld := publicKey(2)
	ipShared := "10.100.0.20"

	ackContent := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, keyOld, ipShared)
	os.WriteFile(filepath.Join(ackDir, opID+".removed"), []byte(ackContent), 0644)

	stalePeerFile := "98765432-1111-1111-1111-111111111111.peer"
	os.WriteFile(filepath.Join(reqDir, stalePeerFile), []byte(fmt.Sprintf("%s\n%s\n", keyOld, ipShared)), 0600)

	cycle(reqDir, ackDir)

	peersData, _ := os.ReadFile(peersFile)
	if strings.Contains(string(peersData), keyOld) {
		t.Fatal("stale keyOld resurrected into wg0 despite durable .removed ACK")
	}

	errData, err := os.ReadFile(filepath.Join(ackDir, "98765432-1111-1111-1111-111111111111.error"))
	if err != nil || strings.TrimSpace(string(errData)) != "PEER_REVOKED" {
		t.Fatalf("expected PEER_REVOKED for stale peer, got %v (%q)", err, string(errData))
	}
}

func TestRemovedOldKeyAndNewKeySameIPUnaffected(t *testing.T) {
	enforceRootOwner = false
	fakeWg, peersFile, _ := setupFakeWg(t)
	oldWg := wgExecutable
	wgExecutable = fakeWg
	defer func() {
		wgExecutable = oldWg
		enforceRootOwner = true
	}()

	reqDir := t.TempDir()
	ackDir := t.TempDir()

	opID := "99999999-9999-9999-9999-999999999999"
	nodeID := "88888888-8888-8888-8888-888888888888"
	invID := "77777777-7777-7777-7777-777777777777"
	keyOld := publicKey(3)
	keyNew := publicKey(4)
	ipShared := "10.100.0.30"

	ackContent := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, keyOld, ipShared)
	os.WriteFile(filepath.Join(ackDir, opID+".removed"), []byte(ackContent), 0644)

	newPeerFile := "12345678-1234-1234-1234-123456789abc.peer"
	os.WriteFile(filepath.Join(reqDir, newPeerFile), []byte(fmt.Sprintf("%s\n%s\n", keyNew, ipShared)), 0600)

	cycle(reqDir, ackDir)

	peersData, _ := os.ReadFile(peersFile)
	if !strings.Contains(string(peersData), keyNew) || !strings.Contains(string(peersData), ipShared) {
		t.Fatalf("new peer using recycled IP was not added: %s", string(peersData))
	}

	readyData, err := os.ReadFile(filepath.Join(ackDir, "12345678-1234-1234-1234-123456789abc.ready"))
	if err != nil {
		t.Fatalf("expected ready file for new peer not found: %v", err)
	}
	expectedReady := fmt.Sprintf("%s\n%s\n", keyNew, ipShared)
	if string(readyData) != expectedReady {
		t.Fatalf("expected ready %q, got %q", expectedReady, string(readyData))
	}
}

// Conflicting remove request must NOT remove an unrelated legitimate live peer,
// must NOT reject legitimate additions for that key, and must preserve the original ACK.
func TestConflictingRemovePreservesOriginalAckAndUnrelatedPeer(t *testing.T) {
	enforceRootOwner = false
	fakeWg, peersFile, _ := setupFakeWg(t)
	oldWg := wgExecutable
	wgExecutable = fakeWg
	defer func() {
		wgExecutable = oldWg
		enforceRootOwner = true
	}()

	reqDir := t.TempDir()
	ackDir := t.TempDir()

	opID := "55555555-5555-5555-5555-555555555555"
	nodeID := "66666666-6666-6666-6666-666666666666"
	invID := "77777777-7777-7777-7777-777777777777"
	keyOriginal := publicKey(5)
	keyNewLive := publicKey(6)
	ipOrig := "10.100.0.50"
	ipNew := "10.100.0.51"

	// 1. Valid durable root ACK already exists for opID / keyOriginal
	originalAckContent := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, keyOriginal, ipOrig)
	ackPath := filepath.Join(ackDir, opID+".removed")
	if err := os.WriteFile(ackPath, []byte(originalAckContent), 0644); err != nil {
		t.Fatal(err)
	}

	// 2. keyNewLive is a legitimate peer currently live on wg0
	os.WriteFile(peersFile, []byte(fmt.Sprintf("%s\t%s/32\n", keyNewLive, ipNew)), 0600)

	// 3. A pending add for keyNewLive is also present in requests
	addReqPath := filepath.Join(reqDir, "66666666-6666-6666-6666-666666666666.peer")
	os.WriteFile(addReqPath, []byte(fmt.Sprintf("%s\n%s\n", keyNewLive, ipNew)), 0600)

	// 4. A conflicting remove request arrives for the same opID but specifying keyNewLive
	conflictReqContent := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, keyNewLive, ipNew)
	conflictingReqPath := filepath.Join(reqDir, opID+".remove")
	os.WriteFile(conflictingReqPath, []byte(conflictReqContent), 0600)

	cycle(reqDir, ackDir)

	// Verify error was written for the conflicting remove
	errData, err := os.ReadFile(filepath.Join(ackDir, opID+".remove-error"))
	if err != nil || strings.TrimSpace(string(errData)) != "REMOVE_ACK_CONFLICT" {
		t.Fatalf("expected REMOVE_ACK_CONFLICT, got %v (%q)", err, string(errData))
	}

	// Verify original .removed file was preserved exactly
	ackDataAfter, err := os.ReadFile(ackPath)
	if err != nil {
		t.Fatalf("original .removed file was lost: %v", err)
	}
	if string(ackDataAfter) != originalAckContent {
		t.Fatalf("original .removed content modified: got %q, want %q", string(ackDataAfter), originalAckContent)
	}

	// REGRESSION CHECK: keyNewLive MUST REMAIN LIVE on wg0
	peersData, _ := os.ReadFile(peersFile)
	if !strings.Contains(string(peersData), keyNewLive) {
		t.Fatalf("REGRESSION: unrelated live peer keyNewLive was removed due to conflicting remove request")
	}

	// REGRESSION CHECK: keyNewLive addition MUST NOT be denied (should have .ready)
	if _, err := os.Stat(filepath.Join(ackDir, "66666666-6666-6666-6666-666666666666.ready")); err != nil {
		t.Fatalf("expected .ready for keyNewLive, but found error or missing: %v", err)
	}

	// 5. Remove the conflicting request, simulate stale peer add for keyOriginal: must STILL be blocked
	os.Remove(conflictingReqPath)
	stalePeerReq := filepath.Join(reqDir, "99999999-9999-9999-9999-999999999999.peer")
	os.WriteFile(stalePeerReq, []byte(fmt.Sprintf("%s\n%s\n", keyOriginal, ipOrig)), 0600)

	cycle(reqDir, ackDir)

	staleErr, err := os.ReadFile(filepath.Join(ackDir, "99999999-9999-9999-9999-999999999999.error"))
	if err != nil || strings.TrimSpace(string(staleErr)) != "PEER_REVOKED" {
		t.Fatalf("expected stale peer to remain blocked by preserved original ACK, got %v (%q)", err, string(staleErr))
	}
}

func TestFailedRemovalAndRetrySuccess(t *testing.T) {
	enforceRootOwner = false
	fakeWg, peersFile, failFile := setupFakeWg(t)
	oldWg := wgExecutable
	wgExecutable = fakeWg
	defer func() {
		wgExecutable = oldWg
		enforceRootOwner = true
	}()

	reqDir := t.TempDir()
	ackDir := t.TempDir()

	opID := "44444444-4444-4444-4444-444444444444"
	nodeID := "55555555-5555-5555-5555-555555555555"
	invID := "66666666-6666-6666-6666-666666666666"
	key := publicKey(12)
	ip := "10.100.0.60"

	os.WriteFile(peersFile, []byte(fmt.Sprintf("%s\t%s/32\n", key, ip)), 0600)
	removeContent := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, key, ip)
	os.WriteFile(filepath.Join(reqDir, opID+".remove"), []byte(removeContent), 0600)

	// 1. Simulate remove command failure: no .removed ACK, .remove-error recorded
	os.WriteFile(failFile, []byte("fail"), 0600)
	cycle(reqDir, ackDir)

	if _, err := os.Stat(filepath.Join(ackDir, opID+".removed")); err == nil {
		t.Fatal(".removed ACK should not be written when remove command fails")
	}
	errData, err := os.ReadFile(filepath.Join(ackDir, opID+".remove-error"))
	if err != nil || strings.TrimSpace(string(errData)) != "PEER_REMOVE_FAILED" {
		t.Fatalf("expected PEER_REMOVE_FAILED error, got %v (%q)", err, string(errData))
	}

	// 2. Clear fault and retry: exact .removed ACK written, stale .remove-error cleared
	os.Remove(failFile)
	cycle(reqDir, ackDir)

	ackData, err := os.ReadFile(filepath.Join(ackDir, opID+".removed"))
	if err != nil || string(ackData) != removeContent {
		t.Fatalf("expected exact .removed ACK after fault cleared, got %v (%q)", err, string(ackData))
	}
	if _, err := os.Stat(filepath.Join(ackDir, opID+".remove-error")); err == nil {
		t.Fatal("stale .remove-error should be removed after successful retry")
	}
}

func TestRemovalProcessedBeforeAllAdditions(t *testing.T) {
	enforceRootOwner = false
	fakeWg, peersFile, _ := setupFakeWg(t)
	oldWg := wgExecutable
	wgExecutable = fakeWg
	defer func() {
		wgExecutable = oldWg
		enforceRootOwner = true
	}()

	reqDir := t.TempDir()
	ackDir := t.TempDir()

	revokedKey := publicKey(7)
	ip := "10.100.0.77"

	// Create 513 stale .peer files with names 00000000-..., 00000001-...
	for i := 0; i < 513; i++ {
		fname := fmt.Sprintf("%08x-0000-0000-0000-000000000000.peer", i)
		os.WriteFile(filepath.Join(reqDir, fname), []byte(fmt.Sprintf("%s\n%s\n", revokedKey, ip)), 0600)
	}

	// Create .remove request with name ffffffff-... (lexicographically last)
	opID := "ffffffff-ffff-ffff-ffff-ffffffffffff"
	nodeID := "12345678-1234-1234-1234-123456789abc"
	invID := "abcdef01-1234-1234-1234-123456789abc"
	removeContent := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, revokedKey, ip)
	os.WriteFile(filepath.Join(reqDir, opID+".remove"), []byte(removeContent), 0600)

	cycle(reqDir, ackDir)

	peersData, _ := os.ReadFile(peersFile)
	if strings.Contains(string(peersData), revokedKey) {
		t.Fatalf("revokedKey was resurrected because removal was skipped or sorted after additions")
	}

	if _, err := os.Stat(filepath.Join(ackDir, opID+".removed")); err != nil {
		t.Fatalf("expected .removed ACK was not written: %v", err)
	}
}

func TestReconcileReappearingPeerFromAck(t *testing.T) {
	enforceRootOwner = false
	fakeWg, peersFile, _ := setupFakeWg(t)
	oldWg := wgExecutable
	wgExecutable = fakeWg
	defer func() {
		wgExecutable = oldWg
		enforceRootOwner = true
	}()

	reqDir := t.TempDir()
	ackDir := t.TempDir()

	opID := "77777777-7777-7777-7777-777777777777"
	nodeID := "88888888-8888-8888-8888-888888888888"
	invID := "99999999-9999-9999-9999-999999999999"
	keyRevoked := publicKey(8)
	keyNew := publicKey(9)
	ipShared := "10.100.0.88"

	// Durable ACK exists in acks/, no .remove request in requests/
	ackContent := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, keyRevoked, ipShared)
	os.WriteFile(filepath.Join(ackDir, opID+".removed"), []byte(ackContent), 0644)

	// Simulate interface recreation: keyRevoked reappears in wg0 alongside legitimate peer keyNew
	os.WriteFile(peersFile, []byte(fmt.Sprintf("%s\t%s/32\n%s\t%s/32\n", keyRevoked, ipShared, keyNew, "10.100.0.89")), 0600)

	cycle(reqDir, ackDir)

	peersData, _ := os.ReadFile(peersFile)
	if strings.Contains(string(peersData), keyRevoked) {
		t.Fatalf("reappearing keyRevoked was not reconciled and removed from wg0")
	}
	if !strings.Contains(string(peersData), keyNew) {
		t.Fatalf("unrelated keyNew was mistakenly removed from wg0")
	}
}

func TestStrictPermissionsAndCanonicalFormat(t *testing.T) {
	dir := t.TempDir()
	opID := "33333333-3333-3333-3333-333333333333"
	nodeID := "44444444-4444-4444-4444-444444444444"
	invID := "55555555-5555-5555-5555-555555555555"
	key := publicKey(10)
	ip := "10.100.0.90"
	content := fmt.Sprintf("1\n%s\n%s\n%s\n%s\n%s\n", opID, nodeID, invID, key, ip)

	ackPath := filepath.Join(dir, opID+".removed")
	os.WriteFile(ackPath, []byte(content), 0644)
	if err := os.Chmod(ackPath, 0666); err != nil {
		t.Fatal(err)
	}

	enforceRootOwner = false
	defer func() { enforceRootOwner = true }()

	if _, _, err := readRemovedAck(ackPath); err == nil {
		t.Fatal("readRemovedAck accepted group/world writable file")
	}

	enforceRootOwner = true
	os.Chmod(ackPath, 0644)
	if os.Getuid() != 0 {
		if _, _, err := readRemovedAck(ackPath); err == nil {
			t.Fatal("readRemovedAck accepted non-root owned file when enforceRootOwner is true")
		}
		if safeDirectory(dir, true) {
			t.Fatal("safeDirectory accepted non-root owned directory when rootOwned is true")
		}
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
	if !removeIdentifier.MatchString("12345678-1234-1234-1234-123456789abc.remove") {
		t.Error("UUID remove filename rejected")
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
