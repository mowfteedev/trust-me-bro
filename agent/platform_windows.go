//go:build windows && (amd64 || arm64)

package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unicode"
	"unicode/utf16"
	"unsafe"
)

const defaultNodeID = "node-windows-01"
const defaultNetworkInterface = "zt-worker"
const defaultDiskMountPoint = `C:\`
const windowsServiceName = "ZTServerOpsAgent"

func validatePlatformConfig(cfg config) error {
	if len(utf16.Encode([]rune(cfg.NetworkInterface))) > 256 || strings.TrimSpace(cfg.NetworkInterface) != cfg.NetworkInterface || cfg.NetworkInterface == "" || strings.IndexFunc(cfg.NetworkInterface, unicode.IsControl) >= 0 {
		return fmt.Errorf("NETWORK_INTERFACE must name one Windows interface alias (1–256 UTF-16 characters)")
	}
	// Monitor one local drive/path. Reject UNC shares so a privileged service
	// cannot be made to authenticate to a remote SMB server while measuring disk.
	if !filepath.IsAbs(cfg.DiskMountPoint) || len(filepath.VolumeName(cfg.DiskMountPoint)) != 2 || cfg.DiskMountPoint[1] != ':' || strings.ContainsAny(cfg.DiskMountPoint, "\x00\r\n") {
		return fmt.Errorf("DISK_MOUNT_POINT must be an absolute local Windows drive path")
	}
	return nil
}

// Native SCM integration, using the documented Win32 ABI instead of a wrapper
// process or another dependency. The installer uses the LocalService identity.
func runPlatformService(run func(context.Context) error) error {
	advapi := systemDLL("advapi32.dll")
	dispatch := advapi.NewProc("StartServiceCtrlDispatcherW")
	register := advapi.NewProc("RegisterServiceCtrlHandlerExW")
	setStatus := advapi.NewProc("SetServiceStatus")
	name, _ := syscall.UTF16PtrFromString(windowsServiceName)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type status struct {
		ServiceType, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint uint32
	}
	var mu sync.Mutex
	var handle uintptr
	current := status{ServiceType: 0x10} // SERVICE_WIN32_OWN_PROCESS
	update := func(state, accepted, exit uint32) {
		mu.Lock()
		defer mu.Unlock()
		current.CurrentState, current.ControlsAccepted, current.Win32ExitCode = state, accepted, exit
		current.CheckPoint, current.WaitHint = 0, 0
		if state == 2 || state == 3 { // START_PENDING / STOP_PENDING
			current.CheckPoint, current.WaitHint = 1, 10000
		}
		setStatus.Call(handle, uintptr(unsafe.Pointer(&current)))
	}
	handler := syscall.NewCallback(func(control, eventType uint32, eventData, context uintptr) uintptr {
		switch control {
		case 1, 5: // STOP / SHUTDOWN
			update(3, 0, 0)
			cancel() // Cancels in-flight HTTP, initial sample wait and retry backoff.
		case 4: // INTERROGATE: repeat current status.
			mu.Lock()
			setStatus.Call(handle, uintptr(unsafe.Pointer(&current)))
			mu.Unlock()
		default:
			return 120 // ERROR_CALL_NOT_IMPLEMENTED
		}
		return 0
	})
	// ServiceMain executes on a foreign SCM thread. Transfer its result through
	// a Go channel rather than assuming the native dispatcher synchronizes Go data.
	result := make(chan error, 1)
	main := syscall.NewCallback(func(argc uint32, argv uintptr) uintptr {
		registered, _, err := register.Call(uintptr(unsafe.Pointer(name)), handler, 0)
		if registered == 0 {
			result <- fmt.Errorf("register service handler: %w", err)
			return 0
		}
		mu.Lock()
		handle = registered
		mu.Unlock()
		update(2, 0, 0)
		update(4, 1|4, 0) // RUNNING; accepts STOP and SHUTDOWN.
		runErr := run(ctx)
		if runErr != nil {
			update(1, 0, 1) // STOPPED with failure, visible to service recovery.
		} else {
			update(1, 0, 0)
		}
		result <- runErr
		return 0
	})
	type serviceEntry struct {
		Name     *uint16
		Callback uintptr
	}
	table := [2]serviceEntry{{Name: name, Callback: main}, {}}
	ok, _, err := dispatch.Call(uintptr(unsafe.Pointer(&table[0])))
	if ok == 0 {
		return fmt.Errorf("Windows service dispatch failed (start via Start-Service): %w", err)
	}
	return <-result
}
