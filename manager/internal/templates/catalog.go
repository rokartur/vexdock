package templates

// Catalog is the curated list, in the order the picker shows it. Every fragment
// is a compose service body at zero indentation and reaches its generated
// values through ${VAR}, which resolves from the environment's .env file.
//
// Adding an entry is adding one struct here: pin the image to a major tag,
// name every volume after its service, and declare a variable for anything the
// stack must not ship with a default.
var Catalog = []Template{
	{
		Slug:        "n8n",
		Name:        "n8n",
		Description: "Workflow automation with a visual editor.",
		Tags:        []string{"automation"},
		Domain:      &Domain{Service: "n8n", Port: 5678},
		Variables: []Variable{
			{Key: "N8N_HOST", Value: Hostname},
			{Key: "N8N_ENCRYPTION_KEY", Value: Generate},
		},
		Services: []Service{{
			Name: "n8n",
			fragment: `image: docker.n8n.io/n8nio/n8n:1.73.1
restart: unless-stopped
environment:
  N8N_HOST: ${N8N_HOST}
  N8N_PORT: "5678"
  N8N_PROTOCOL: https
  N8N_PROXY_HOPS: "1"
  WEBHOOK_URL: https://${N8N_HOST}/
  N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY}
  GENERIC_TIMEZONE: UTC
volumes:
  - n8n-data:/home/node/.n8n`,
		}},
	},
	{
		Slug:        "uptime-kuma",
		Name:        "Uptime Kuma",
		Description: "Uptime monitoring and status pages.",
		Tags:        []string{"monitoring"},
		Domain:      &Domain{Service: "uptime-kuma", Port: 3001},
		Services: []Service{{
			Name: "uptime-kuma",
			fragment: `image: louislam/uptime-kuma:1
restart: unless-stopped
volumes:
  - uptime-kuma-data:/app/data`,
		}},
	},
	{
		Slug:        "vaultwarden",
		Name:        "Vaultwarden",
		Description: "Bitwarden-compatible password manager.",
		Tags:        []string{"security"},
		Domain:      &Domain{Service: "vaultwarden", Port: 80},
		Variables: []Variable{
			{Key: "VAULTWARDEN_HOST", Value: Hostname},
			{Key: "VAULTWARDEN_ADMIN_TOKEN", Value: Generate},
		},
		Services: []Service{{
			Name: "vaultwarden",
			fragment: `image: vaultwarden/server:1.33.2
restart: unless-stopped
environment:
  DOMAIN: https://${VAULTWARDEN_HOST}
  ADMIN_TOKEN: ${VAULTWARDEN_ADMIN_TOKEN}
  SIGNUPS_ALLOWED: "true"
volumes:
  - vaultwarden-data:/data`,
		}},
	},
	{
		Slug:        "ghost",
		Name:        "Ghost",
		Description: "Publishing platform with a MySQL database.",
		Tags:        []string{"cms"},
		Domain:      &Domain{Service: "ghost", Port: 2368},
		Variables: []Variable{
			{Key: "GHOST_HOST", Value: Hostname},
			{Key: "GHOST_DB_PASSWORD", Value: Generate},
			{Key: "GHOST_DB_ROOT_PASSWORD", Value: Generate},
		},
		Services: []Service{
			{
				Name: "ghost",
				fragment: `image: ghost:5-alpine
restart: unless-stopped
environment:
  url: https://${GHOST_HOST}
  database__client: mysql
  database__connection__host: ghost-db
  database__connection__port: "3306"
  database__connection__user: ghost
  database__connection__password: ${GHOST_DB_PASSWORD}
  database__connection__database: ghost
depends_on:
  - ghost-db
volumes:
  - ghost-content:/var/lib/ghost/content`,
			},
			{
				Name: "ghost-db",
				fragment: `image: mysql:8
restart: unless-stopped
environment:
  MYSQL_ROOT_PASSWORD: ${GHOST_DB_ROOT_PASSWORD}
  MYSQL_DATABASE: ghost
  MYSQL_USER: ghost
  MYSQL_PASSWORD: ${GHOST_DB_PASSWORD}
volumes:
  - ghost-db-data:/var/lib/mysql`,
			},
		},
	},
	{
		Slug:        "wordpress",
		Name:        "WordPress",
		Description: "WordPress with a MySQL database.",
		Tags:        []string{"cms"},
		Domain:      &Domain{Service: "wordpress", Port: 80},
		Variables: []Variable{
			{Key: "WORDPRESS_DB_PASSWORD", Value: Generate},
			{Key: "WORDPRESS_DB_ROOT_PASSWORD", Value: Generate},
		},
		Services: []Service{
			{
				Name: "wordpress",
				fragment: `image: wordpress:6-apache
restart: unless-stopped
environment:
  WORDPRESS_DB_HOST: wordpress-db
  WORDPRESS_DB_NAME: wordpress
  WORDPRESS_DB_USER: wordpress
  WORDPRESS_DB_PASSWORD: ${WORDPRESS_DB_PASSWORD}
depends_on:
  - wordpress-db
volumes:
  - wordpress-data:/var/www/html`,
			},
			{
				Name: "wordpress-db",
				fragment: `image: mysql:8
restart: unless-stopped
environment:
  MYSQL_ROOT_PASSWORD: ${WORDPRESS_DB_ROOT_PASSWORD}
  MYSQL_DATABASE: wordpress
  MYSQL_USER: wordpress
  MYSQL_PASSWORD: ${WORDPRESS_DB_PASSWORD}
volumes:
  - wordpress-db-data:/var/lib/mysql`,
			},
		},
	},
	{
		Slug:        "umami",
		Name:        "Umami",
		Description: "Privacy-friendly web analytics with PostgreSQL.",
		Tags:        []string{"analytics"},
		Domain:      &Domain{Service: "umami", Port: 3000},
		Variables: []Variable{
			{Key: "UMAMI_DB_PASSWORD", Value: Generate},
			{Key: "UMAMI_APP_SECRET", Value: Generate},
		},
		Services: []Service{
			{
				Name: "umami",
				fragment: `image: ghcr.io/umami-software/umami:postgresql-v2.14.0
restart: unless-stopped
environment:
  DATABASE_TYPE: postgresql
  DATABASE_URL: postgresql://umami:${UMAMI_DB_PASSWORD}@umami-db:5432/umami
  APP_SECRET: ${UMAMI_APP_SECRET}
depends_on:
  - umami-db`,
			},
			{
				Name: "umami-db",
				fragment: `image: postgres:16-alpine
restart: unless-stopped
environment:
  POSTGRES_DB: umami
  POSTGRES_USER: umami
  POSTGRES_PASSWORD: ${UMAMI_DB_PASSWORD}
volumes:
  - umami-db-data:/var/lib/postgresql/data`,
			},
		},
	},
	{
		Slug:        "metabase",
		Name:        "Metabase",
		Description: "Business intelligence dashboards with PostgreSQL.",
		Tags:        []string{"analytics"},
		Domain:      &Domain{Service: "metabase", Port: 3000},
		Variables: []Variable{
			{Key: "METABASE_DB_PASSWORD", Value: Generate},
		},
		Services: []Service{
			{
				Name: "metabase",
				fragment: `image: metabase/metabase:v0.52.8
restart: unless-stopped
environment:
  MB_DB_TYPE: postgres
  MB_DB_HOST: metabase-db
  MB_DB_PORT: "5432"
  MB_DB_DBNAME: metabase
  MB_DB_USER: metabase
  MB_DB_PASS: ${METABASE_DB_PASSWORD}
depends_on:
  - metabase-db`,
			},
			{
				Name: "metabase-db",
				fragment: `image: postgres:16-alpine
restart: unless-stopped
environment:
  POSTGRES_DB: metabase
  POSTGRES_USER: metabase
  POSTGRES_PASSWORD: ${METABASE_DB_PASSWORD}
volumes:
  - metabase-db-data:/var/lib/postgresql/data`,
			},
		},
	},
	{
		Slug:        "grafana",
		Name:        "Grafana",
		Description: "Dashboards for metrics and logs.",
		Tags:        []string{"monitoring"},
		Domain:      &Domain{Service: "grafana", Port: 3000},
		Variables: []Variable{
			{Key: "GRAFANA_HOST", Value: Hostname},
			{Key: "GRAFANA_ADMIN_PASSWORD", Value: Generate},
		},
		Services: []Service{{
			Name: "grafana",
			fragment: `image: grafana/grafana:11.4.0
restart: unless-stopped
environment:
  GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD}
  GF_SERVER_ROOT_URL: https://${GRAFANA_HOST}
volumes:
  - grafana-data:/var/lib/grafana`,
		}},
	},
}
