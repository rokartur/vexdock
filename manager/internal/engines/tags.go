package engines

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// tagLookupTimeout keeps the version picker responsive: Docker Hub being slow
// must degrade to the offline list, never hang the dashboard.
const tagLookupTimeout = 5 * time.Second

// maxTags caps what the picker shows. Docker Hub returns hundreds of tags for a
// popular image and none of the tail is a version anyone deliberately picks.
const maxTags = 60

// Versions lists the tags available for an engine: the catalog's curated ones
// first, then everything else Docker Hub knows about. Hub orders by last push,
// which puts an old patch release at the top of an unsorted list, so the
// curated entries are what makes the picker's first suggestion a sane one.
// When Hub cannot be reached the curated list is the answer on its own.
//
// The repository is taken from the catalog and never from the caller, so this
// cannot be pointed at an arbitrary host. The custom engine has no repository
// and therefore no lookup: the user types the image reference themselves.
func Versions(ctx context.Context, engine Engine) ([]string, error) {
	if engine.Repository == "" {
		return nil, fmt.Errorf("engine %q has no curated repository", engine.Slug)
	}
	ctx, cancel := context.WithTimeout(ctx, tagLookupTimeout)
	defer cancel()

	endpoint := "https://hub.docker.com/v2/repositories/" + url.PathEscape(engine.Repository) +
		"/tags?page_size=100&ordering=last_updated"
	// PathEscape encodes the slash in "library/postgres"; Docker Hub wants it raw.
	endpoint = strings.Replace(endpoint, "%2F", "/", 1)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return engine.Versions, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return engine.Versions, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return engine.Versions, fmt.Errorf("docker hub returned %s", resp.Status)
	}

	// Only the tag names are read; everything else in the payload is ignored.
	var body struct {
		Results []struct {
			Name string `json:"name"`
		} `json:"results"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&body); err != nil {
		return engine.Versions, err
	}

	out := append([]string{}, engine.Versions...)
	seen := map[string]bool{}
	for _, v := range out {
		seen[v] = true
	}
	for _, r := range body.Results {
		// A tag from the network ends up in an image reference, so it is held
		// to exactly the same pattern as one typed by a user.
		if !tagPattern.MatchString(r.Name) || seen[r.Name] {
			continue
		}
		seen[r.Name] = true
		out = append(out, r.Name)
		if len(out) == maxTags {
			break
		}
	}
	return out, nil
}
