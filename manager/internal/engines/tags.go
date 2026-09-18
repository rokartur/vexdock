package engines

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// tagLookupTimeout keeps the version picker responsive: Docker Hub being slow
// must degrade to the offline list, never hang the dashboard.
const tagLookupTimeout = 5 * time.Second

// maxTags caps what the picker shows. Docker Hub returns hundreds of tags for a
// popular image and none of the tail is a version anyone deliberately picks.
const maxTags = 60

// Versions lists an engine's tags newest first: the curated list merged with
// what Docker Hub knows, ordered by version rather than by push date, so a
// freshly published major leads and the curated list cannot go stale. When Hub
// is unreachable the curated list is the whole answer. The repository comes
// from the catalog and never from the caller, so this cannot be pointed at an
// arbitrary host; the custom engine has none and is never looked up.
func Versions(ctx context.Context, engine Engine) ([]string, error) {
	if engine.Repository == "" {
		return nil, fmt.Errorf("engine %q has no curated repository", engine.Slug)
	}
	// A repository qualified with its own registry host is not on Docker Hub, so
	// the curated list is all there is to offer.
	if strings.Contains(strings.SplitN(engine.Repository, "/", 2)[0], ".") {
		return engine.Versions, nil
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
	}
	newestFirst(out)
	if len(out) > maxTags {
		out = out[:maxTags]
	}
	return out, nil
}

// leadingVersion matches the version a tag starts with: 18 in "18-alpine3.24",
// 0.24.33 in "v0.24.33", nothing in "bookworm".
var leadingVersion = regexp.MustCompile(`^v?(\d+(?:\.\d+)*)`)

// prerelease keeps a beta of the next major from outranking the current one.
var prerelease = regexp.MustCompile(`(?i)alpha|beta|rc|nightly|unstable|preview`)

// newestFirst sorts tags by the version they start with, descending. "latest"
// leads, prereleases sink below released versions, and a tag with no version in
// front keeps its Docker Hub order at the bottom. On a shared prefix the
// shorter tag wins, so the floating "18" sits above "18.6-alpine3.24".
func newestFirst(tags []string) {
	numbers := make(map[string][]int, len(tags))
	for _, t := range tags {
		numbers[t] = versionNumbers(t)
	}
	sort.SliceStable(tags, func(i, j int) bool {
		a, b := tags[i], tags[j]
		if ga, gb := tagGroup(a, numbers[a]), tagGroup(b, numbers[b]); ga != gb {
			return ga < gb
		}
		return newer(numbers[a], numbers[b])
	})
}

func versionNumbers(tag string) []int {
	match := leadingVersion.FindStringSubmatch(tag)
	if match == nil {
		return nil
	}
	var out []int
	for _, part := range strings.Split(match[1], ".") {
		n, err := strconv.Atoi(part)
		if err != nil {
			return out
		}
		out = append(out, n)
	}
	return out
}

func tagGroup(tag string, numbers []int) int {
	switch {
	case tag == "latest":
		return 0
	case len(numbers) == 0:
		return 3
	case prerelease.MatchString(tag):
		return 2
	default:
		return 1
	}
}

func newer(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return len(a) < len(b)
}
