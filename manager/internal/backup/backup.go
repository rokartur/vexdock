// Package backup snapshots the platform's own state: the database, the
// generated proxy configuration and the certificates. Application data (user
// volumes) is deliberately out of scope.
package backup

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
)

type Service struct {
	cfg *config.Config
	db  *database.DB
}

func New(cfg *config.Config, db *database.DB) *Service { return &Service{cfg: cfg, db: db} }

// Snapshot describes one backup directory.
type Snapshot struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	CreatedAt string `json:"created_at"`
	SizeBytes int64  `json:"size_bytes"`
}

// Create writes a new snapshot and returns it.
func (s *Service) Create(ctx context.Context) (*Snapshot, error) {
	name := time.Now().UTC().Format("2006-01-02T150405")
	dir := filepath.Join(s.cfg.BackupsDir, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	// VACUUM INTO produces a consistent copy while the database stays open.
	dbCopy := filepath.Join(dir, "app.db")
	if _, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, dbCopy); err != nil {
		return nil, fmt.Errorf("snapshot database: %w", err)
	}
	if err := copyTree(s.cfg.NginxDir, filepath.Join(dir, "nginx")); err != nil {
		return nil, err
	}
	if err := copyTree(s.cfg.CertificatesDir, filepath.Join(dir, "certificates")); err != nil {
		return nil, err
	}
	// The system compose file and its .env define which images are running.
	for _, name := range []string{"compose.yml", ".env"} {
		src := filepath.Join(s.cfg.Root, name)
		if _, err := os.Stat(src); err == nil {
			if err := copyFile(src, filepath.Join(dir, "config-"+strings.TrimPrefix(name, "."))); err != nil {
				return nil, err
			}
		}
	}

	size, _ := dirSize(dir)
	return &Snapshot{Name: name, Path: dir, CreatedAt: time.Now().UTC().Format(time.RFC3339), SizeBytes: size}, nil
}

// List returns existing snapshots, newest first.
func (s *Service) List() ([]Snapshot, error) {
	entries, err := os.ReadDir(s.cfg.BackupsDir)
	if err != nil {
		return nil, err
	}
	out := []Snapshot{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		path := filepath.Join(s.cfg.BackupsDir, e.Name())
		size, _ := dirSize(path)
		out = append(out, Snapshot{
			Name:      e.Name(),
			Path:      path,
			CreatedAt: info.ModTime().UTC().Format(time.RFC3339),
			SizeBytes: size,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	return out, nil
}

// Prune keeps the newest n snapshots.
func (s *Service) Prune(keep int) error {
	snapshots, err := s.List()
	if err != nil {
		return err
	}
	for i, snap := range snapshots {
		if i < keep {
			continue
		}
		if err := os.RemoveAll(snap.Path); err != nil {
			return err
		}
	}
	return nil
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func dirSize(path string) (int64, error) {
	var total int64
	err := filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}
