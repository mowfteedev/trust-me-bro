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

var identifier = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.peer$`)

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
	parts := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(parts) != 2 {
		return "", netip.Addr{}, nil, errors.New("invalid request lines")
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
	return parts[0], ip, []byte(parts[0] + "\n" + ip.String() + "\n"), nil
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

func command(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "wg", args...).Output()
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
	if stat, err := os.Lstat(target); err == nil && !stat.Mode().IsRegular() {
		return errors.New("unsafe acknowledgement")
	}
	if previous, err := os.ReadFile(target); err == nil && string(previous) == string(data) {
		return nil
	}
	f, err := os.CreateTemp(directory, ".peer-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Chmod(0644); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), target)
}

func acknowledge(directory, name string, data []byte) error {
	return writeResult(directory, strings.TrimSuffix(name, ".peer")+".ready", data)
}

func reject(directory, name, reason string) {
	_ = os.Remove(filepath.Join(directory, strings.TrimSuffix(name, ".peer")+".ready"))
	_ = writeResult(directory, strings.TrimSuffix(name, ".peer")+".error", []byte(reason+"\n"))
}

func cycle(requests, acks string) {
	if !safeDirectory(requests, false) || !safeDirectory(acks, true) {
		return
	}
	entries, err := os.ReadDir(requests)
	if err != nil {
		return
	}
	// One classroom Gateway has at most 252 additional IPv4 peers.
	if len(entries) > 512 {
		return
	}
	for _, entry := range entries {
		if !identifier.MatchString(entry.Name()) || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		key, ip, data, err := readRequest(filepath.Join(requests, entry.Name()))
		if err != nil {
			continue
		}
		output, err := command("show", "wg0", "allowed-ips")
		if err != nil {
			reject(acks, entry.Name(), "PEER_APPLY_FAILED")
			continue
		}
		exists, err := validatePeers(string(output), key, ip)
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
