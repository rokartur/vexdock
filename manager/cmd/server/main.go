// Command server is the platform manager: the only component with access to
// the Docker socket. Nginx terminates traffic and proxies /api here.
//
// Copyright (C) 2026 Platform contributors.
// Licensed under the GNU Affero General Public License v3.0 or later; see the
// LICENSE file at the repository root.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/vexdock/platform/manager/internal/api"
	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/backup"
	"github.com/vexdock/platform/manager/internal/certificates"
	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/deployments"
	"github.com/vexdock/platform/manager/internal/docker"
	"github.com/vexdock/platform/manager/internal/domains"
	"github.com/vexdock/platform/manager/internal/events"
	"github.com/vexdock/platform/manager/internal/nginx"
	"github.com/vexdock/platform/manager/internal/notify"
	"github.com/vexdock/platform/manager/internal/projects"
	"github.com/vexdock/platform/manager/internal/security"
	"github.com/vexdock/platform/manager/internal/updater"
)

// releaseAPI is polled for the newest published version.
const releaseAPI = "https://api.github.com/repos/vexdock/platform/releases/latest"

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the local manager and exit 0 when healthy")
	flag.Parse()
	if *healthcheck {
		os.Exit(probeHealth())
	}
	if err := run(); err != nil {
		slog.Error("manager stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel()}))
	slog.SetDefault(log)

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	log.Info("starting manager", "version", cfg.Version, "root", cfg.Root)

	db, err := database.Open(cfg.DatabasePath())
	if err != nil {
		return err
	}
	defer db.Close()

	cipher, err := security.LoadOrCreateCipher(cfg.MasterKeyPath())
	if err != nil {
		return err
	}

	dockerClient, err := docker.New()
	if err != nil {
		return err
	}
	defer dockerClient.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := dockerClient.Ping(ctx); err != nil {
		return fmt.Errorf("docker daemon unreachable: %w", err)
	}
	if err := dockerClient.EnsureNetwork(ctx, cfg.ProxyNetwork); err != nil {
		return fmt.Errorf("proxy network: %w", err)
	}

	bus := events.NewBus()
	nginxManager := nginx.NewManager(
		filepath.Join(cfg.NginxDir, "generated"),
		cfg.NginxContainer,
		dockerClient,
		log.With("component", "nginx"),
	)
	certIssuer := certificates.NewIssuer(
		cfg.CertificatesDir,
		filepath.Join(cfg.NginxDir, "acme-challenge"),
		cfg.ACMEDirectory,
		cfg.ACMEEmail,
	)
	if err := loadCloudflareToken(ctx, db, cipher, certIssuer); err != nil {
		log.Warn("cloudflare token unavailable, falling back to http-01", "error", err)
	}
	authService, err := auth.New(db, cfg)
	if err != nil {
		return err
	}
	defer authService.Close()
	projectService := projects.New(db, cfg, cipher)
	domainService := domains.New(db, cfg, dockerClient, nginxManager, certIssuer, log.With("component", "domains"))
	deploymentEngine := deployments.NewEngine(db, cfg, projectService, domainService, dockerClient, bus,
		log.With("component", "deployment"))
	backupService := backup.New(cfg, db, dockerClient)
	updaterService := updater.New(cfg, backupService, releaseAPI)

	if err := deploymentEngine.RecoverInterrupted(ctx); err != nil {
		log.Warn("recover interrupted deployments", "error", err)
	}

	server := api.New(api.Deps{
		Config: cfg, DB: db, Auth: authService, Projects: projectService, Domains: domainService,
		Deployments: deploymentEngine, Docker: dockerClient, Nginx: nginxManager, Certs: certIssuer,
		Bus: bus, Updater: updaterService, Backups: backupService, Cipher: cipher,
		Log: log.With("component", "api"),
	})

	reconciler := events.NewReconciler(dockerClient, domainService, bus, log.With("component", "reconciler"))
	go reconciler.Run(ctx)
	go scheduler(ctx, db, domainService, backupService, log.With("component", "scheduler"))
	go notify.New(db, bus, log.With("component", "notify")).Run(ctx)

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		// Long-lived SSE streams and terminals need an unbounded write deadline.
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second,
		BaseContext:  func(net.Listener) context.Context { return context.Background() },
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.ListenAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}

// loadCloudflareToken applies the stored DNS-01 credential to the issuer at
// boot. Without it the issuer stays on HTTP-01, which cannot do wildcards.
func loadCloudflareToken(ctx context.Context, db *database.DB, cipher *security.Cipher,
	issuer *certificates.Issuer) error {
	stored, err := db.Setting(ctx, certificates.SettingCloudflareToken)
	if err != nil || stored == "" {
		return err
	}
	token, err := cipher.Decrypt(stored)
	if err != nil {
		return err
	}
	issuer.SetCloudflareToken(token)
	return nil
}

// scheduler runs the platform's periodic work: certificate renewal, session
// cleanup and backup retention. One goroutine, no cron dependency.
func scheduler(ctx context.Context, db *database.DB, domainService *domains.Service,
	backupService *backup.Service, log *slog.Logger) {
	// Renewals are checked shortly after boot and then every six hours.
	first := time.NewTimer(time.Minute)
	defer first.Stop()
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()

	work := func() {
		domainService.RenewExpiring(ctx)
		if err := db.PruneAudit(ctx, 5000); err != nil {
			log.Warn("audit retention", "error", err)
		}
		if err := backupService.Prune(10); err != nil {
			log.Warn("backup retention", "error", err)
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-first.C:
			work()
		case <-ticker.C:
			work()
		}
	}
}

// probeHealth is used by the container HEALTHCHECK and by the updater, so the
// image needs no curl or wget.
func probeHealth() int {
	addr := os.Getenv("PLATFORM_LISTEN")
	if addr == "" {
		addr = ":8080"
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://127.0.0.1" + addr + "/api/health")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "health returned %d\n", resp.StatusCode)
		return 1
	}
	return 0
}

func logLevel() slog.Level {
	switch os.Getenv("PLATFORM_LOG_LEVEL") {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
