// Package migrations embeds the SQL schema files so the manager binary carries
// its own schema and can migrate on start with no external files.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
