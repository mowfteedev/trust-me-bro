package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
)

func start(args []string, logger *log.Logger) error {
	flags := flag.NewFlagSet("zt-agent", flag.ContinueOnError)
	configPath := flags.String("config", "", "JSON settings file; otherwise read environment")
	service := flags.Bool("service", false, "run under Windows Service Control Manager")
	check := flags.Bool("check", false, "collect and print one real sample without sending HTTP")
	validate := flags.Bool("validate-config", false, "validate settings without collecting or connecting")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || (*service && (*check || *validate)) {
		return fmt.Errorf("unexpected arguments or incompatible service/diagnostic flags")
	}
	var cfg config
	var err error
	if *configPath == "" {
		cfg, err = loadConfig()
	} else {
		cfg, err = loadConfigFile(*configPath)
	}
	if err != nil {
		return err
	}
	if *validate {
		logger.Print("configuration valid (no collection or network request)")
		return nil
	}
	if *service {
		if *configPath == "" {
			return fmt.Errorf("Windows service requires --config")
		}
		output, err := newServiceLog(*configPath)
		if err != nil {
			return err
		}
		defer output.Close()
		logger.SetOutput(output)
		err = runPlatformService(func(ctx context.Context) error { return runAgent(ctx, cfg, false, logger) })
		if err != nil {
			logger.Print(err) // Record the cause before the service log is closed.
		}
		logger.SetOutput(os.Stderr)
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return runAgent(ctx, cfg, *check, logger)
}
