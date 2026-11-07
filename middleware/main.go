// Command middleware is the server side of Rendez-vous: it validates the page's requests, calls the routing
// engines and answers the proposals (docs/architecture.md). For now it only answers GET /v1/health, so that the
// whole deployment chain (CI, image, server, Caddy) is validated before the computation is written.
//
// Configuration, by environment variables:
//
//	ALLOWED_ORIGINS  comma-separated origins allowed by CORS, e.g. "https://rendez-vous.gresset-bourgeois.fr"
//	PLACES_FILE      the places and zones file (default /places.json, where the image puts data/pois-toulouse.json)
//
// With -healthcheck, it queries the health of the server running on this machine and exits (0: healthy):
// Docker calls it, since the image has no shell nor wget.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const listenAddr = ":8080"

func main() {
	healthcheck := flag.Bool("healthcheck", false, "query the local server's health and exit (0: healthy)")
	flag.Parse()
	if *healthcheck {
		os.Exit(checkHealth("http://127.0.0.1" + listenAddr + "/v1/health"))
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	origins := parseOrigins(os.Getenv("ALLOWED_ORIGINS"))
	if len(origins) == 0 {
		logger.Error("ALLOWED_ORIGINS is empty")
		os.Exit(1)
	}

	placesFile := os.Getenv("PLACES_FILE")
	if placesFile == "" {
		placesFile = "/places.json"
	}
	data, err := loadData(placesFile)
	if err != nil {
		logger.Error("places file", "error", err)
		os.Exit(1)
	}
	logger.Info("places loaded", "counts", data.summary(), "sha256", data.Version.SHA256)

	server := &http.Server{
		Addr:    listenAddr,
		Handler: newHandler(origins, logger),
		// Timeouts: a client cannot hold a connection by sending its request slowly
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}

	// On SIGTERM (docker stop) or SIGINT, stop accepting connections and let the running requests finish
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			logger.Error("shutdown", "error", err)
		}
		close(shutdownDone)
	}()

	logger.Info("listening", "addr", listenAddr, "origins", len(origins))
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server", "error", err)
		os.Exit(1)
	}
	<-shutdownDone
	logger.Info("stopped")
}

// checkHealth returns the exit code of -healthcheck: 0 when the server answers 200 in time, 1 otherwise.
func checkHealth(url string) int {
	client := &http.Client{Timeout: 2 * time.Second}
	res, err := client.Get(url)
	if err != nil {
		return 1
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
