package security

import (
	"fmt"
	"regexp"
	"strings"
)

// A capture reference in a redirect replacement, in nginx's $1 form or the
// ${1} form Traefik and Dokploy use.
var captureRef = regexp.MustCompile(`\$\{?([0-9])\}?`)

// ValidateRedirect checks a redirect before it is written into a quoted nginx
// string, and returns the replacement with ${N} rewritten to nginx's $N.
// The regex must compile and must not end the quoted string or turn into
// something else through nginx's own \" \\ \t \r \n unescaping.
func ValidateRedirect(regex, replacement string) (string, error) {
	if regex == "" || replacement == "" {
		return "", fmt.Errorf("regex and replacement are required")
	}
	if len(regex) > 500 || len(replacement) > 500 {
		return "", fmt.Errorf("regex and replacement must be at most 500 characters")
	}
	if !quotable(regex) || !quotable(replacement) {
		return "", fmt.Errorf("regex and replacement must not contain quotes or control characters")
	}
	for i := 0; i < len(regex); i++ {
		if regex[i] != '\\' {
			continue
		}
		if i == len(regex)-1 || strings.ContainsRune(`\'trn`, rune(regex[i+1])) {
			return "", fmt.Errorf(`regex must not end in \ or use \\, \', \t, \r or \n`)
		}
		i++
	}
	if _, err := regexp.Compile(regex); err != nil {
		return "", fmt.Errorf("invalid regex: %v", err)
	}
	if strings.Contains(replacement, `\`) {
		return "", fmt.Errorf(`replacement must not contain \`)
	}
	normalized := captureRef.ReplaceAllString(replacement, `$$$1`)
	if strings.Count(normalized, "$") != len(captureRef.FindAllString(normalized, -1)) {
		return "", fmt.Errorf("replacement may only use $ for a capture such as $1")
	}
	return normalized, nil
}

// ValidateBasicAuthUser checks a user for an htpasswd file, where a colon ends
// the name and a newline ends the entry. The password is only ever hashed.
func ValidateBasicAuthUser(username, password string) error {
	if username == "" || password == "" {
		return fmt.Errorf("username and password are required")
	}
	if len(username) > 100 || len(password) > 200 {
		return fmt.Errorf("username must be at most 100 and password at most 200 characters")
	}
	if strings.Contains(username, ":") || !quotable(username) {
		return fmt.Errorf("username must not contain a colon, quotes or control characters")
	}
	return nil
}

// ValidatePublishedPort checks a host port mapping. 80 and 443 belong to nginx.
func ValidatePublishedPort(published, target int, protocol string) error {
	if err := ValidatePort(published); err != nil {
		return fmt.Errorf("published %w", err)
	}
	if err := ValidatePort(target); err != nil {
		return fmt.Errorf("target %w", err)
	}
	if published == 80 || published == 443 {
		return fmt.Errorf("ports 80 and 443 are used by the platform's proxy")
	}
	if protocol != "tcp" && protocol != "udp" {
		return fmt.Errorf("protocol must be tcp or udp")
	}
	return nil
}

func quotable(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r == '"' {
			return false
		}
	}
	return true
}
