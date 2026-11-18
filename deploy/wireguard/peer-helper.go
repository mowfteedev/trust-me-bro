package main

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

var (
	identifier           = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.peer$`)
	removeIdentifier     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.remove$`)
	removedAckIdentifier = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.removed$`)
	uuidRegex            = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

	// enforceRootOwner is true in production, can be set to false in unit tests.
	enforceRootOwner = true
	// wgExecutable allows overriding wg path in unit tests.
	wgExecutable = "wg"
)

type RemoveRequest struct {
	Version        string
	OperationID    string
	NodeID         string
	InvitationID   string
	PublicKey      string
	IP             netip.Addr
	CanonicalBytes []byte
}

func readRequest(path string) (string, netip.Addr, []byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return "", netip.Addr{}, nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 128 {
		return "", netip.Addr{}, nil, errors.New("invalid request file")
	}
	data, err := io.ReadAll(io.LimitReader(f, 129))
	if err != nil || len(data) > 128 {
		return "", netip.Addr{}, nil, errors.New("invalid request size")
	}
	content := string(data)
	if !strings.HasSuffix(content, "\n") || strings.Contains(content, "\r") {
		return "", netip.Addr{}, nil, errors.New("invalid request format: missing terminal newline or CRLF")
	}
	parts := strings.Split(content, "\n")
	if len(parts) != 3 || parts[2] != "" {
		return "", netip.Addr{}, nil, errors.New("invalid request lines")
	}
	if content != parts[0]+"\n"+parts[1]+"\n" {
		return "", netip.Addr{}, nil, errors.New("non-canonical request content")
	}
	key, err := base64.StdEncoding.DecodeString(parts[0])
	if err != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != parts[0] {
		return "", netip.Addr{}, nil, errors.New("invalid public key")
	}
	zero := true
	for _, b := range key {
		if b != 0 {
			zero = false
		}
	}
	if zero {
		return "", netip.Addr{}, nil, errors.New("zero public key")
	}
	ip, err := netip.ParseAddr(parts[1])
	if err != nil || !ip.Is4() || ip.String() != parts[1] {
		return "", netip.Addr{}, nil, errors.New("invalid address")
	}
	bytes := ip.As4()
	if bytes[0] != 10 || bytes[1] != 100 || bytes[2] != 0 || bytes[3] < 3 || bytes[3] > 254 {
		return "", netip.Addr{}, nil, errors.New("address outside enrollment range")
	}
	return parts[0], ip, []byte(content), nil
}

func parseRemovalDescriptor(path string, isAck bool) (*RemoveRequest, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 512 {
		return nil, errors.New("invalid removal descriptor file")
	}
	// Group/world writable files are rejected.
	if stat.Mode().Perm()&0022 != 0 {
		return nil, errors.New("unsafe file permissions: group/world writable")
	}
	if isAck && enforceRootOwner {
		sysStat, ok := stat.Sys().(*syscall.Stat_t)
		if !ok || sysStat.Uid != 0 {
			return nil, errors.New("unsafe removed ack ownership")
		}
	}
	data, err := io.ReadAll(io.LimitReader(f, 513))
	if err != nil || len(data) > 512 {
		return nil, errors.New("invalid removal descriptor size")
	}
	content := string(data)
	if !strings.HasSuffix(content, "\n") || strings.Contains(content, "\r") {
		return nil, errors.New("invalid removal descriptor format: missing terminal newline or CRLF")
	}
	parts := strings.Split(content, "\n")
	if len(parts) != 7 || parts[6] != "" {
		return nil, errors.New("invalid removal descriptor line count")
	}
	expectedCanonical := strings.Join(parts[:6], "\n") + "\n"
	if content != expectedCanonical {
		return nil, errors.New("non-canonical removal descriptor content")
	}
	if parts[0] != "1" {
		return nil, errors.New("unsupported removal descriptor version")
	}
	operationID := parts[1]
	if !uuidRegex.MatchString(operationID) {
		return nil, errors.New("invalid operation UUID")
	}
	expectedSuffix := ".remove"
	if isAck {
		expectedSuffix = ".removed"
	}
	if filepath.Base(path) != operationID+expectedSuffix {
		return nil, errors.New("operation UUID does not match filename")
	}
	nodeID := parts[2]
	if !uuidRegex.MatchString(nodeID) {
		return nil, errors.New("invalid node UUID")
	}
	invitationID := parts[3]
	if !uuidRegex.MatchString(invitationID) {
		return nil, errors.New("invalid invitation UUID")
	}
	key, err := base64.StdEncoding.DecodeString(parts[4])
	if err != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != parts[4] {
		return nil, errors.New("invalid public key")
	}
	zero := true
	for _, b := range key {
		if b != 0 {
			zero = false
		}
	}
	if zero {
		return nil, errors.New("zero public key")
	}
	ip, err := netip.ParseAddr(parts[5])
	if err != nil || !ip.Is4() || ip.String() != parts[5] {
		return nil, errors.New("invalid address")
	}
	bytes := ip.As4()
	if bytes[0] != 10 || bytes[1] != 100 || bytes[2] != 0 || bytes[3] < 3 || bytes[3] > 254 {
		return nil, errors.New("address outside enrollment range")
	}
	return &RemoveRequest{
		Version:        parts[0],
		OperationID:    operationID,
		NodeID:         nodeID,
		InvitationID:   invitationID,
		PublicKey:      parts[4],
		IP:             ip,
		CanonicalBytes: []byte(expectedCanonical),
	}, nil
}

func readRemoveRequest(path string) (*RemoveRequest, error) {
	return parseRemovalDescriptor(path, false)
}

func readRemovedAck(path string) (string, []byte, error) {
	req, err := parseRemovalDescriptor(path, true)
	if err != nil {
		return "", nil, err
	}
	return req.PublicKey, req.CanonicalBytes, nil
}

// An enrollment cannot change a live peer's routes or overlap any existing route.
func validatePeers(output, key string, ip netip.Addr) (bool, error) {
	exists := false
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if len(fields) < 2 {
			return false, errors.New("unrecognized peer output")
		}
		routes := strings.Split(strings.Join(fields[1:], ""), ",")
		if fields[0] == key {
			if len(routes) != 1 || routes[0] != ip.String()+"/32" {
				return false, errors.New("existing peer identity conflict")
			}
			exists = true
			continue
		}
		for _, route := range routes {
			if route == "(none)" {
				continue
			}
			prefix, err := netip.ParsePrefix(route)
			if err != nil {
				return false, errors.New("unrecognized peer route")
			}
			if prefix.Contains(ip) {
				return false, errors.New("existing peer route overlap")
			}
		}
	}
	return exists, nil
}

func isPeerPresent(output, key string) bool {
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == key {
			return true
		}
	}
	return false
}

func command(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, wgExecutable, args...).Output()
}

func safeDirectory(path string, rootOwned bool) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != filepath.Clean(path) {
		return false
	}
	if rootOwned {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != 0 || info.Mode().Perm()&0022 != 0 {
			return false
		}
	}
	return true
}

func writeResult(directory, name string, data []byte) error {
	target := filepath.Join(directory, name)
	if stat, err := os.Lstat(target); err == nil {
		if !stat.Mode().IsRegular() {
			return errors.New("unsafe acknowledgement")
		}
		if previous, err := os.ReadFile(target); err == nil && string(previous) == string(data) {
			return nil
		}
	}
	f, err := os.CreateTemp(directory, ".peer-*")
	if err != nil {
		return err
	}
	tempName := f.Name()
	cleanupTemp := true
	defer func() {
		if cleanupTemp {
			_ = os.Remove(tempName)
		}
	}()
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Chmod(0644); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(tempName, target); err != nil {
		return err
	}
	cleanupTemp = false

	// Directory fsync ensures durable persistence on disk; failures clean newly published target.
	dir, err := os.Open(directory)
	if err != nil {
		_ = os.Remove(target)
		return err
	}
	defer dir.Close()
	if err = dir.Sync(); err != nil {
		_ = os.Remove(target)
		return err
	}
	return nil
}

func acknowledge(directory, name string, data []byte) error {
	return writeResult(directory, strings.TrimSuffix(name, ".peer")+".ready", data)
}

func reject(directory, name, reason string) {
	_ = os.Remove(filepath.Join(directory, strings.TrimSuffix(name, ".peer")+".ready"))
	_ = writeResult(directory, strings.TrimSuffix(name, ".peer")+".error", []byte(reason+"\n"))
}

func rejectRemove(directory, operationID, reason string) {
	// Preserves any existing .removed ACK file intact.
	_ = writeResult(directory, operationID+".remove-error", []byte(reason+"\n"))
}

func cycle(requests, acks string) {
	if !safeDirectory(requests, false) || !safeDirectory(acks, enforceRootOwner) {
		return
	}

	// 1. Load durable root-owned .removed ACKs to populate denied keys and existing ACKs.
	ackEntries, err := os.ReadDir(acks)
	if err != nil {
		return
	}
	deniedKeys := make(map[string]bool)
	existingRemovedAcks := make(map[string][]byte) // operationID -> canonicalBytes
	for _, entry := range ackEntries {
		if entry.Type()&os.ModeSymlink != 0 || !removedAckIdentifier.MatchString(entry.Name()) {
			continue
		}
		key, canonical, err := readRemovedAck(filepath.Join(acks, entry.Name()))
		if err == nil {
			deniedKeys[key] = true
			opID := strings.TrimSuffix(entry.Name(), ".removed")
			existingRemovedAcks[opID] = canonical
		}
	}

	// 2. Scan requests directory and validate removal requests against existing ACKs BEFORE admitting keys.
	entries, err := os.ReadDir(requests)
	if err != nil {
		return
	}

	var validRemovals []*RemoveRequest
	var peerEntries []os.DirEntry
	conflictingOperations := make(map[string]bool)
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if removeIdentifier.MatchString(entry.Name()) {
			req, err := readRemoveRequest(filepath.Join(requests, entry.Name()))
			if err != nil {
				continue
			}
			// Validate against existing root ACK for this operation BEFORE adding to deniedKeys.
			if existing, ok := existingRemovedAcks[req.OperationID]; ok {
				if string(existing) != string(req.CanonicalBytes) {
					conflictingOperations[req.OperationID] = true
					rejectRemove(acks, req.OperationID, "REMOVE_ACK_CONFLICT")
					// Do not admit the conflicting key to deniedKeys or validRemovals.
					continue
				}
				// Matching ACK already exists: do not re-add to validRemovals for re-ACK,
				// but ensure its key is admitted to deniedKeys for live reconciliation.
				deniedKeys[req.PublicKey] = true
				continue
			}
			// New valid removal request:
			deniedKeys[req.PublicKey] = true
			validRemovals = append(validRemovals, req)
		} else if identifier.MatchString(entry.Name()) {
			peerEntries = append(peerEntries, entry)
		}
	}

	// 3. Reconcile desired absence: remove all live keys present in deniedKeys from WireGuard.
	removeFailures := make(map[string]bool)
	output, err := command("show", "wg0", "allowed-ips")
	if err == nil {
		for key := range deniedKeys {
			if isPeerPresent(string(output), key) {
				if _, err := command("set", "wg0", "peer", key, "remove"); err != nil {
					removeFailures[key] = true
				}
			}
		}
	}

	// 4. Publish ACKs and clean up stale errors for verified removals.
	outputVerify, errVerify := command("show", "wg0", "allowed-ips")
	for _, req := range validRemovals {
		if removeFailures[req.PublicKey] {
			rejectRemove(acks, req.OperationID, "PEER_REMOVE_FAILED")
			continue
		}
		if errVerify != nil {
			rejectRemove(acks, req.OperationID, "PEER_SHOW_FAILED")
			continue
		}
		if isPeerPresent(string(outputVerify), req.PublicKey) {
			rejectRemove(acks, req.OperationID, "PEER_REMOVE_VERIFY_FAILED")
			continue
		}

		if err = writeResult(acks, req.OperationID+".removed", req.CanonicalBytes); err == nil {
			_ = os.Remove(filepath.Join(acks, req.OperationID+".remove-error"))
			existingRemovedAcks[req.OperationID] = req.CanonicalBytes
		} else {
			rejectRemove(acks, req.OperationID, "ACK_WRITE_FAILED")
		}
	}

	// Clean up stale .remove-error for matching existing ACKs once peer absence is verified.
	if errVerify == nil {
		for opID, canonical := range existingRemovedAcks {
			if conflictingOperations[opID] {
				continue
			}
			parts := strings.Split(string(canonical), "\n")
			if len(parts) > 4 && !isPeerPresent(string(outputVerify), parts[4]) {
				_ = os.Remove(filepath.Join(acks, opID+".remove-error"))
			}
		}
	}

	// 5. Process peer additions AFTER all removals and denylist population.
	for _, entry := range peerEntries {
		key, ip, data, err := readRequest(filepath.Join(requests, entry.Name()))
		if err != nil {
			continue
		}

		// Permanent denylist check: skip add if key was removed or requested removed.
		if deniedKeys[key] {
			_ = os.Remove(filepath.Join(acks, strings.TrimSuffix(entry.Name(), ".peer")+".ready"))
			reject(acks, entry.Name(), "PEER_REVOKED")
			continue
		}

		outputCurrent, err := command("show", "wg0", "allowed-ips")
		if err != nil {
			reject(acks, entry.Name(), "PEER_APPLY_FAILED")
			continue
		}
		exists, err := validatePeers(string(outputCurrent), key, ip)
		if err != nil {
			reject(acks, entry.Name(), "PEER_CONFLICT")
			continue
		}
		if !exists {
			if _, err = command("set", "wg0", "peer", key, "allowed-ips", ip.String()+"/32"); err != nil {
				reject(acks, entry.Name(), "PEER_APPLY_FAILED")
				continue
			}
		}
		if acknowledge(acks, entry.Name(), data) == nil {
			_ = os.Remove(filepath.Join(acks, strings.TrimSuffix(entry.Name(), ".peer")+".error"))
		}
	}
}

func main() {
	requests, acks := os.Getenv("ENROLLMENT_REQUEST_DIR"), os.Getenv("ENROLLMENT_ACK_DIR")
	if requests == "" || acks == "" {
		return
	}
	for {
		cycle(requests, acks)
		time.Sleep(2 * time.Second)
	}
}
