package database

import (
	"context"
	"database/sql"
	"errors"
)

const domainColumns = `id, project_id, environment_id, service_id, hostname, container_port, https_enabled, redirect_https,
	certificate_source, analytics, created_at, updated_at`

func (db *DB) CreateDomain(ctx context.Context, d *Domain) error {
	d.CreatedAt, d.UpdatedAt = Now(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO domains (`+domainColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.ID, d.ProjectID, d.EnvironmentID, d.ServiceID, d.Hostname, d.ContainerPort,
		boolToInt(d.HTTPSEnabled), boolToInt(d.RedirectHTTPS), d.CertificateSource, boolToInt(d.Analytics),
		d.CreatedAt, d.UpdatedAt)
	return err
}

func (db *DB) UpdateDomain(ctx context.Context, d *Domain) error {
	d.UpdatedAt = Now()
	_, err := db.ExecContext(ctx,
		`UPDATE domains SET service_id=?, hostname=?, container_port=?, https_enabled=?, redirect_https=?,
		 certificate_source=?, analytics=?, updated_at=? WHERE id=?`,
		d.ServiceID, d.Hostname, d.ContainerPort, boolToInt(d.HTTPSEnabled), boolToInt(d.RedirectHTTPS),
		d.CertificateSource, boolToInt(d.Analytics), d.UpdatedAt, d.ID)
	return err
}

func (db *DB) DeleteDomain(ctx context.Context, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM domains WHERE id = ?`, id)
	return err
}

func (db *DB) DomainByID(ctx context.Context, id string) (*Domain, error) {
	return scanDomain(db.QueryRowContext(ctx, `SELECT `+domainColumns+` FROM domains WHERE id = ?`, id))
}

func (db *DB) DomainByHostname(ctx context.Context, hostname string) (*Domain, error) {
	return scanDomain(db.QueryRowContext(ctx, `SELECT `+domainColumns+` FROM domains WHERE hostname = ?`, hostname))
}

func (db *DB) ListDomains(ctx context.Context) ([]Domain, error) {
	return db.queryDomains(ctx, `SELECT `+domainColumns+` FROM domains ORDER BY hostname`)
}

func (db *DB) ListProjectDomains(ctx context.Context, projectID string) ([]Domain, error) {
	return db.queryDomains(ctx, `SELECT `+domainColumns+` FROM domains WHERE project_id = ? ORDER BY hostname`, projectID)
}

func (db *DB) ListEnvironmentDomains(ctx context.Context, environmentID string) ([]Domain, error) {
	return db.queryDomains(ctx, `SELECT `+domainColumns+` FROM domains WHERE environment_id = ? ORDER BY hostname`, environmentID)
}

func (db *DB) queryDomains(ctx context.Context, query string, args ...any) ([]Domain, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Domain{}
	for rows.Next() {
		d, err := scanDomain(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

func scanDomain(row scanner) (*Domain, error) {
	var d Domain
	var https, redirect, analytics int
	err := row.Scan(&d.ID, &d.ProjectID, &d.EnvironmentID, &d.ServiceID, &d.Hostname, &d.ContainerPort, &https, &redirect,
		&d.CertificateSource, &analytics, &d.CreatedAt, &d.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	d.HTTPSEnabled, d.RedirectHTTPS, d.Analytics = https != 0, redirect != 0, analytics != 0
	return &d, nil
}

const certColumns = `id, domain_id, hostname, issuer, issued_at, expires_at, last_renewed_at, status, last_error, source`

// UpsertCertificate records the outcome of an ACME issuance or renewal.
func (db *DB) UpsertCertificate(ctx context.Context, c *Certificate) error {
	if c.ID == "" {
		c.ID = NewID()
	}
	_, err := db.ExecContext(ctx,
		`INSERT INTO certificates (`+certColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (domain_id) DO UPDATE SET hostname=excluded.hostname, issuer=excluded.issuer,
		   issued_at=excluded.issued_at, expires_at=excluded.expires_at, last_renewed_at=excluded.last_renewed_at,
		   status=excluded.status, last_error=excluded.last_error, source=excluded.source`,
		c.ID, c.DomainID, c.Hostname, c.Issuer, c.IssuedAt, c.ExpiresAt, c.LastRenewedAt, c.Status, c.LastError, c.Source)
	return err
}

func (db *DB) CertificateByDomain(ctx context.Context, domainID string) (*Certificate, error) {
	var c Certificate
	err := db.QueryRowContext(ctx, `SELECT `+certColumns+` FROM certificates WHERE domain_id = ?`, domainID).
		Scan(&c.ID, &c.DomainID, &c.Hostname, &c.Issuer, &c.IssuedAt, &c.ExpiresAt, &c.LastRenewedAt, &c.Status,
			&c.LastError, &c.Source)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (db *DB) ListCertificates(ctx context.Context) ([]Certificate, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+certColumns+` FROM certificates ORDER BY hostname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Certificate{}
	for rows.Next() {
		var c Certificate
		if err := rows.Scan(&c.ID, &c.DomainID, &c.Hostname, &c.Issuer, &c.IssuedAt, &c.ExpiresAt,
			&c.LastRenewedAt, &c.Status, &c.LastError, &c.Source); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (db *DB) CreateRegistry(ctx context.Context, r *Registry) error {
	r.ID, r.CreatedAt = NewID(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO registries (id, name, url, username, encrypted_password, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		r.ID, r.Name, r.URL, r.Username, r.EncryptedPassword, r.CreatedAt)
	return err
}

func (db *DB) DeleteRegistry(ctx context.Context, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM registries WHERE id = ?`, id)
	return err
}

func (db *DB) ListRegistries(ctx context.Context) ([]Registry, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, name, url, username, encrypted_password, created_at FROM registries ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Registry{}
	for rows.Next() {
		var r Registry
		if err := rows.Scan(&r.ID, &r.Name, &r.URL, &r.Username, &r.EncryptedPassword, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (db *DB) Setting(ctx context.Context, key string) (string, error) {
	var v string
	err := db.QueryRowContext(ctx, `SELECT value FROM system_settings WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return v, err
}

func (db *DB) SetSetting(ctx context.Context, key, value string) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, value, Now())
	return err
}
