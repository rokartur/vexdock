package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/vexdock/platform/manager/internal/database"
)

// APIError is the single error shape every endpoint returns, so the frontend
// can map codes to messages instead of parsing prose.
type APIError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

type errorEnvelope struct {
	Error APIError `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, message string, details map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorEnvelope{Error: APIError{Code: code, Message: message, Details: details}})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	_ = json.NewEncoder(w).Encode(payload)
}

// badRequest reports a validation failure with the message the caller can show.
func badRequest(w http.ResponseWriter, err error) {
	writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error(), nil)
}

// serverError logs nothing here; callers log. It never leaks internals beyond
// the error text the platform itself produced.
func serverError(w http.ResponseWriter, err error) {
	writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error(), nil)
}

// notFound maps database.ErrNotFound consistently.
func handleLookupError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, database.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Resource not found", nil)
		return true
	}
	serverError(w, err)
	return true
}

// decode reads a JSON body with a hard size limit.
func decode(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 2<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid request body: %w", err)
	}
	return nil
}
