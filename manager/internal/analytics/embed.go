package analytics

import _ "embed"

// Beacon is the script served to visitors of a domain with analytics enabled.
//
//go:embed beacon.js
var Beacon string
