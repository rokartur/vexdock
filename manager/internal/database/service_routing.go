package database

import "context"

// ServiceRedirect sends a request whose full URL matches Regex to Replacement,
// which may use the regex's captures as $1, $2 and so on.
type ServiceRedirect struct {
	ID          string `json:"id"`
	ServiceID   string `json:"service_id"`
	Regex       string `json:"regex"`
	Replacement string `json:"replacement"`
	Permanent   bool   `json:"permanent"`
	CreatedAt   string `json:"created_at"`
}

// ServiceBasicAuth is one user nginx lets through to the service's domains.
type ServiceBasicAuth struct {
	ID           string `json:"id"`
	ServiceID    string `json:"service_id"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"`
	CreatedAt    string `json:"created_at"`
}

// ServicePort publishes Target of the service's container on the host's Published port.
type ServicePort struct {
	ID        string `json:"id"`
	ServiceID string `json:"service_id"`
	Published int    `json:"published"`
	Target    int    `json:"target"`
	Protocol  string `json:"protocol"`
	CreatedAt string `json:"created_at"`
}

func (db *DB) CreateServiceRedirect(ctx context.Context, r *ServiceRedirect) error {
	r.ID, r.CreatedAt = NewID(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO service_redirects (id, service_id, regex, replacement, permanent, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		r.ID, r.ServiceID, r.Regex, r.Replacement, boolToInt(r.Permanent), r.CreatedAt)
	return err
}

// ServiceRedirects lists in creation order, which is the order nginx tries them.
func (db *DB) ServiceRedirects(ctx context.Context, serviceID string) ([]ServiceRedirect, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, service_id, regex, replacement, permanent, created_at FROM service_redirects WHERE service_id = ? ORDER BY created_at, id`,
		serviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ServiceRedirect{}
	for rows.Next() {
		var r ServiceRedirect
		var permanent int
		if err := rows.Scan(&r.ID, &r.ServiceID, &r.Regex, &r.Replacement, &permanent, &r.CreatedAt); err != nil {
			return nil, err
		}
		r.Permanent = permanent == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

func (db *DB) DeleteServiceRedirect(ctx context.Context, serviceID, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM service_redirects WHERE service_id = ? AND id = ?`, serviceID, id)
	return err
}

func (db *DB) CreateServiceBasicAuth(ctx context.Context, a *ServiceBasicAuth) error {
	a.ID, a.CreatedAt = NewID(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO service_basic_auth (id, service_id, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
		a.ID, a.ServiceID, a.Username, a.PasswordHash, a.CreatedAt)
	return err
}

func (db *DB) ServiceBasicAuths(ctx context.Context, serviceID string) ([]ServiceBasicAuth, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, service_id, username, password_hash, created_at FROM service_basic_auth WHERE service_id = ? ORDER BY username`,
		serviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ServiceBasicAuth{}
	for rows.Next() {
		var a ServiceBasicAuth
		if err := rows.Scan(&a.ID, &a.ServiceID, &a.Username, &a.PasswordHash, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (db *DB) DeleteServiceBasicAuth(ctx context.Context, serviceID, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM service_basic_auth WHERE service_id = ? AND id = ?`, serviceID, id)
	return err
}

func (db *DB) CreateServicePort(ctx context.Context, p *ServicePort) error {
	p.ID, p.CreatedAt = NewID(), Now()
	_, err := db.ExecContext(ctx,
		`INSERT INTO service_ports (id, service_id, published, target, protocol, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		p.ID, p.ServiceID, p.Published, p.Target, p.Protocol, p.CreatedAt)
	return err
}

func (db *DB) ServicePorts(ctx context.Context, serviceID string) ([]ServicePort, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, service_id, published, target, protocol, created_at FROM service_ports WHERE service_id = ? ORDER BY published, protocol`,
		serviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ServicePort{}
	for rows.Next() {
		var p ServicePort
		if err := rows.Scan(&p.ID, &p.ServiceID, &p.Published, &p.Target, &p.Protocol, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (db *DB) DeleteServicePort(ctx context.Context, serviceID, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM service_ports WHERE service_id = ? AND id = ?`, serviceID, id)
	return err
}
