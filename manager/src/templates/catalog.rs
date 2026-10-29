use super::{Domain, GENERATE, HOSTNAME, Service, Template, Var};

/// The curated list, in the order the picker shows it. Every fragment is a
/// compose service body at zero indentation and reaches its generated values
/// through ${VAR}, which resolves from the environment's .env file.
///
/// Adding an entry is adding one struct here: pin the image to a major tag,
/// name every volume after its service, and declare a variable for anything the
/// stack must not ship with a default.
pub static CATALOG: &[Template] = &[
	Template {
		slug: "n8n",
		name: "n8n",
		description: "Workflow automation with a visual editor.",
		tags: &["automation"],
		domain: Some(Domain { service: "n8n", port: 5678 }),
		variables: &[Var { key: "N8N_HOST", value: HOSTNAME }, Var { key: "N8N_ENCRYPTION_KEY", value: GENERATE }],
		services: &[Service {
			name: "n8n",
			fragment: r#"image: docker.n8n.io/n8nio/n8n:1.73.1
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
  - n8n-data:/home/node/.n8n"#,
		}],
	},
	Template {
		slug: "uptime-kuma",
		name: "Uptime Kuma",
		description: "Uptime monitoring and status pages.",
		tags: &["monitoring"],
		domain: Some(Domain { service: "uptime-kuma", port: 3001 }),
		variables: &[],
		services: &[Service {
			name: "uptime-kuma",
			fragment: r#"image: louislam/uptime-kuma:1
restart: unless-stopped
volumes:
  - uptime-kuma-data:/app/data"#,
		}],
	},
	Template {
		slug: "vaultwarden",
		name: "Vaultwarden",
		description: "Bitwarden-compatible password manager.",
		tags: &["security"],
		domain: Some(Domain { service: "vaultwarden", port: 80 }),
		variables: &[Var { key: "VAULTWARDEN_HOST", value: HOSTNAME }, Var { key: "VAULTWARDEN_ADMIN_TOKEN", value: GENERATE }],
		services: &[Service {
			name: "vaultwarden",
			fragment: r#"image: vaultwarden/server:1.33.2
restart: unless-stopped
environment:
  DOMAIN: https://${VAULTWARDEN_HOST}
  ADMIN_TOKEN: ${VAULTWARDEN_ADMIN_TOKEN}
  SIGNUPS_ALLOWED: "true"
volumes:
  - vaultwarden-data:/data"#,
		}],
	},
	Template {
		slug: "ghost",
		name: "Ghost",
		description: "Publishing platform with a MySQL database.",
		tags: &["cms"],
		domain: Some(Domain { service: "ghost", port: 2368 }),
		variables: &[
			Var { key: "GHOST_HOST", value: HOSTNAME },
			Var { key: "GHOST_DB_PASSWORD", value: GENERATE },
			Var { key: "GHOST_DB_ROOT_PASSWORD", value: GENERATE },
		],
		services: &[
			Service {
				name: "ghost",
				fragment: r#"image: ghost:5-alpine
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
  - ghost-content:/var/lib/ghost/content"#,
			},
			Service {
				name: "ghost-db",
				fragment: r#"image: mysql:8
restart: unless-stopped
environment:
  MYSQL_ROOT_PASSWORD: ${GHOST_DB_ROOT_PASSWORD}
  MYSQL_DATABASE: ghost
  MYSQL_USER: ghost
  MYSQL_PASSWORD: ${GHOST_DB_PASSWORD}
volumes:
  - ghost-db-data:/var/lib/mysql"#,
			},
		],
	},
	Template {
		slug: "wordpress",
		name: "WordPress",
		description: "WordPress with a MySQL database.",
		tags: &["cms"],
		domain: Some(Domain { service: "wordpress", port: 80 }),
		variables: &[Var { key: "WORDPRESS_DB_PASSWORD", value: GENERATE }, Var { key: "WORDPRESS_DB_ROOT_PASSWORD", value: GENERATE }],
		services: &[
			Service {
				name: "wordpress",
				fragment: r#"image: wordpress:6-apache
restart: unless-stopped
environment:
  WORDPRESS_DB_HOST: wordpress-db
  WORDPRESS_DB_NAME: wordpress
  WORDPRESS_DB_USER: wordpress
  WORDPRESS_DB_PASSWORD: ${WORDPRESS_DB_PASSWORD}
depends_on:
  - wordpress-db
volumes:
  - wordpress-data:/var/www/html"#,
			},
			Service {
				name: "wordpress-db",
				fragment: r#"image: mysql:8
restart: unless-stopped
environment:
  MYSQL_ROOT_PASSWORD: ${WORDPRESS_DB_ROOT_PASSWORD}
  MYSQL_DATABASE: wordpress
  MYSQL_USER: wordpress
  MYSQL_PASSWORD: ${WORDPRESS_DB_PASSWORD}
volumes:
  - wordpress-db-data:/var/lib/mysql"#,
			},
		],
	},
	Template {
		slug: "umami",
		name: "Umami",
		description: "Privacy-friendly web analytics with PostgreSQL.",
		tags: &["analytics"],
		domain: Some(Domain { service: "umami", port: 3000 }),
		variables: &[Var { key: "UMAMI_DB_PASSWORD", value: GENERATE }, Var { key: "UMAMI_APP_SECRET", value: GENERATE }],
		services: &[
			Service {
				name: "umami",
				fragment: r#"image: ghcr.io/umami-software/umami:postgresql-v2.14.0
restart: unless-stopped
environment:
  DATABASE_TYPE: postgresql
  DATABASE_URL: postgresql://umami:${UMAMI_DB_PASSWORD}@umami-db:5432/umami
  APP_SECRET: ${UMAMI_APP_SECRET}
depends_on:
  - umami-db"#,
			},
			Service {
				name: "umami-db",
				fragment: r#"image: postgres:16-alpine
restart: unless-stopped
environment:
  POSTGRES_DB: umami
  POSTGRES_USER: umami
  POSTGRES_PASSWORD: ${UMAMI_DB_PASSWORD}
volumes:
  - umami-db-data:/var/lib/postgresql/data"#,
			},
		],
	},
	Template {
		slug: "metabase",
		name: "Metabase",
		description: "Business intelligence dashboards with PostgreSQL.",
		tags: &["analytics"],
		domain: Some(Domain { service: "metabase", port: 3000 }),
		variables: &[Var { key: "METABASE_DB_PASSWORD", value: GENERATE }],
		services: &[
			Service {
				name: "metabase",
				fragment: r#"image: metabase/metabase:v0.52.8
restart: unless-stopped
environment:
  MB_DB_TYPE: postgres
  MB_DB_HOST: metabase-db
  MB_DB_PORT: "5432"
  MB_DB_DBNAME: metabase
  MB_DB_USER: metabase
  MB_DB_PASS: ${METABASE_DB_PASSWORD}
depends_on:
  - metabase-db"#,
			},
			Service {
				name: "metabase-db",
				fragment: r#"image: postgres:16-alpine
restart: unless-stopped
environment:
  POSTGRES_DB: metabase
  POSTGRES_USER: metabase
  POSTGRES_PASSWORD: ${METABASE_DB_PASSWORD}
volumes:
  - metabase-db-data:/var/lib/postgresql/data"#,
			},
		],
	},
	Template {
		slug: "grafana",
		name: "Grafana",
		description: "Dashboards for metrics and logs.",
		tags: &["monitoring"],
		domain: Some(Domain { service: "grafana", port: 3000 }),
		variables: &[Var { key: "GRAFANA_HOST", value: HOSTNAME }, Var { key: "GRAFANA_ADMIN_PASSWORD", value: GENERATE }],
		services: &[Service {
			name: "grafana",
			fragment: r#"image: grafana/grafana:11.4.0
restart: unless-stopped
environment:
  GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD}
  GF_SERVER_ROOT_URL: https://${GRAFANA_HOST}
volumes:
  - grafana-data:/var/lib/grafana"#,
		}],
	},
];
