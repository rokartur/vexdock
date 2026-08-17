package security

import (
	"fmt"
	"path/filepath"
	"strings"
)

// ResolveInside joins a user-supplied relative path onto base and guarantees
// the result stays inside base. It is the single guard against path traversal
// for compose file paths, backup names and project file access.
func ResolveInside(base, rel string) (string, error) {
	if rel == "" {
		return "", fmt.Errorf("path is required")
	}
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("absolute paths are not allowed: %q", rel)
	}
	if strings.ContainsRune(rel, 0) {
		return "", fmt.Errorf("path contains a null byte")
	}
	cleanBase := filepath.Clean(base)
	target := filepath.Clean(filepath.Join(cleanBase, rel))
	if target != cleanBase && !strings.HasPrefix(target, cleanBase+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes its project directory: %q", rel)
	}
	return target, nil
}
