package main

import (
	"log"
	"os"
	"runtime"
)

func main() {
	configureMemoryBudget()
	if _, configured := os.LookupEnv("GOMAXPROCS"); !configured {
		runtime.GOMAXPROCS(1)
	}
	logger := log.New(os.Stderr, "zt-agent ", log.LstdFlags)
	if err := start(os.Args[1:], logger); err != nil {
		logger.Print(err)
		os.Exit(1)
	}
}
