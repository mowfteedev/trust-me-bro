package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// Only the service account and administrators can write this installer-created
// directory. Bound diagnostics to two 1 MiB files; never log credentials.
type serviceLog struct {
	path string
	file *os.File
	size int64
}

func newServiceLog(configPath string) (*serviceLog, error) {
	path := filepath.Join(filepath.Dir(configPath), "logs", "agent.log")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, fmt.Errorf("cannot open service log; verify installer permissions")
	}
	stat, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	return &serviceLog{path: path, file: file, size: stat.Size()}, nil
}

func (w *serviceLog) Write(data []byte) (int, error) {
	if w.size+int64(len(data)) > 1<<20 {
		if err := w.file.Close(); err != nil {
			return 0, err
		}
		if err := os.Remove(w.path + ".1"); err != nil && !os.IsNotExist(err) {
			return 0, err
		}
		if err := os.Rename(w.path, w.path+".1"); err != nil {
			return 0, err
		}
		file, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			return 0, err
		}
		w.file, w.size = file, 0
	}
	n, err := w.file.Write(data)
	w.size += int64(n)
	return n, err
}

func (w *serviceLog) Close() error { return w.file.Close() }
