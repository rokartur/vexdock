/**
 * Typed client for the Go manager API.
 *
 * Requests carry the session cookie and nothing else. Cross-site forgery is
 * blocked by the manager comparing Origin against the request host, so the
 * dashboard has no token to hold: same-origin requests pass, others do not.
 */

export type User = {
	id: string
	email: string
	name: string
}

export type SourceType = 'git' | 'compose'
export type CredentialKind = 'none' | 'token' | 'ssh_key'

export type DeploymentStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled'

export type Deployment = {
	id: string
	project_id: string
	number: number
	/** Compose service this deploy targeted; empty means the whole project. */
	service_name: string
	commit_sha: string
	branch: string
	status: DeploymentStatus
	trigger: string
	created_by: string
	error: string
	started_at: string
	finished_at: string
	created_at: string
}

export type DeploymentStep = {
	id: string
	deployment_id: string
	position: number
	name: string
	status: DeploymentStatus
	output: string
	started_at: string
	finished_at: string
}

export type CertificateSource = 'letsencrypt' | 'custom'

export type Domain = {
	id: string
	project_id: string
	service_id: string
	hostname: string
	container_port: number
	https_enabled: boolean
	redirect_https: boolean
	certificate_source: CertificateSource
	/** Injects the visit beacon into HTML served for this hostname. */
	analytics: boolean
	created_at: string
	updated_at: string
}

/** One bucket of the visits chart. `at` is unix seconds. */
export type TrafficPoint = {
	at: number
	views: number
	visitors: number
}

/** One row of a top-pages, referrers, countries, devices or events table. */
export type Breakdown = {
	name: string
	count: number
	visitors: number
}

/** One window's headline numbers. */
export type TrafficTotals = {
	views: number
	visitors: number
	visits: number
	/** Mean visit length in seconds. */
	avg_duration: number
	/** Share of visits with a single pageview, 0 to 1. */
	bounce_rate: number
}

export type Traffic = TrafficTotals & {
	/** The same window immediately before this one. */
	previous: TrafficTotals
	online: number
	/** Step of `series` in seconds. A bucket with no events is absent from it. */
	bucket: number
	series: TrafficPoint[]
	pages: Breakdown[]
	referrers: Breakdown[]
	countries: Breakdown[]
	devices: Breakdown[]
	browsers: Breakdown[]
	systems: Breakdown[]
	events: Breakdown[]
	online_pages: Breakdown[]
}

export type AnalyticsRange = '24h' | '7d' | '30d'

export type Project = {
	id: string
	name: string
	slug: string
	source_type: SourceType
	repository_url: string
	branch: string
	compose_path: string
	compose_project_name: string
	auto_deploy: boolean
	/** Free-form labels, slugified by the manager. */
	tags: string[]
	git_credential_kind: CredentialKind
	created_at: string
	updated_at: string
	service_count: number
	running_count: number
	domains: Domain[]
	latest_deployment: Deployment | null
	webhook_url: string
	webhook_secret_set: boolean
	/** Every deployable copy of the project, default first. */
	environments: Environment[]
}

/**
 * A deployable copy of a project. It owns the docker namespace, so production
 * and staging never share a container, a volume or a network alias.
 *
 * The default environment carries its project's id, which is what makes an
 * install that predates environments keep running untouched.
 */
export type Environment = {
	id: string
	project_id: string
	name: string
	slug: string
	/** Empty means the environment deploys whatever branch the project does. */
	branch: string
	compose_project_name: string
	is_default: boolean
	created_at: string
	updated_at: string
}

/** An application is built or pulled; a database is a catalog image with a volume. */
export type ServiceType = 'application' | 'database'

/**
 * Where a service's compose definition comes from. 'derived' is read-only: the
 * service exists because the project's own compose file declares it, so the
 * dashboard describes it but never rewrites it. 'unconfigured' is an
 * application that is still only a name, and deploys to nothing until its
 * settings answer where it comes from.
 */
export type ServiceSource = 'derived' | 'unconfigured' | 'git' | 'image' | 'compose'

export type Service = {
	id: string
	project_id: string
	compose_service_name: string
	display_name: string
	type: ServiceType
	source_type: ServiceSource
	repository_url: string
	branch: string
	build_path: string
	/** What the service is configured to run, which is set before it ever deploys. */
	image: string
	engine: string
	/** Where a custom engine's volume mounts. Empty for every curated engine. */
	data_path: string
	compose_fragment: string
	created_at: string
	updated_at: string
	container_id: string
	state: string
	status: string
	/** What the container was actually started from; drifts from image until the next deploy. */
	running_image: string
	health: string
	restart_count: number
	created_unix: number
	/** The sampler's newest reading, zero while the service is not running. */
	cpu_percent: number
	memory_usage: number
}

export type EnvVar = {
	key: string
	value: string
	is_secret: boolean
	updated_at: string
}

export type ScheduledTask = {
	id: string
	service_id: string
	/** Both task lists name the owner, so one table can serve either. */
	service_name: string
	project_id: string
	project_name: string
	name: string
	description: string
	/** Five field cron expression, read against the task's timezone. */
	schedule: string
	/** IANA zone name. */
	timezone: string
	command: string
	shell: TaskShell
	enabled: boolean
	created_at: string
	updated_at: string
	/** Absent until the task has run once. Carries no output. */
	last_run?: TaskRun
	/** Absent while the task is disabled or its expression never comes round. */
	next_run?: string
}

export type TaskShell = 'sh' | 'bash'

/** Everything a task's form writes. Create sends it whole, edit sends a subset. */
export type TaskInput = {
	name: string
	description: string
	schedule: string
	timezone: string
	command: string
	shell: TaskShell
	enabled: boolean
}

export type TaskRun = {
	id: string
	task_id: string
	started_at: string
	/** Empty while the run is still going. */
	finished_at: string
	/** -1 when the command never started. */
	exit_code: number
	output: string
}

export type Certificate = {
	id: string
	domain_id: string
	hostname: string
	issuer: string
	issued_at: string
	expires_at: string
	last_renewed_at: string
	status: 'pending' | 'issued' | 'failed'
	last_error: string
	source: CertificateSource
}

export type ContainerSummary = {
	id: string
	names: string[]
	image: string
	state: string
	status: string
	created: number
	labels: Record<string, string>
	managed: boolean
	project: string
	service: string
	networks: string[] | null
}

/** `remove` refuses a running container: the daemon wants force, which the dashboard never sends. */
export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove'

export type ImageSummary = {
	id: string
	repo_tags: string[] | null
	created: number
	size: number
	containers: number
}

export type VolumeSummary = {
	name: string
	driver: string
	created_at: string
	/** -1 when Docker reported no usage data for this volume. */
	size: number
	ref_count: number
}

export type NetworkSummary = {
	id: string
	name: string
	driver: string
	scope: string
	labels: Record<string, string> | null
	containers: { id: string; name: string; ipv4: string }[]
}

export type SystemInfo = {
	host: {
		docker_version: string
		os: string
		architecture: string
		cpus: number
		memory_total: number
		name: string
	}
	projects: number
	containers: number
	containers_running: number
	containers_stopped: number
	images: number
	recent_deployments: { deployment: Deployment; project_name: string }[]
	version: string
}

export type HostStats = {
	cpu_percent: number
	memory_used: number
	memory_total: number
	disk_used: number
	disk_total: number
	load_average: number
}

export type ContainerStats = {
	container_id: string
	name: string
	cpu_percent: number
	memory_usage: number
	memory_limit: number
	memory_percent: number
	network_rx: number
	network_tx: number
	block_read: number
	block_write: number
	pids: number
}

/** How far back a recorded metrics window may reach. */
export type MetricWindow = '30m' | '1h' | '6h' | '24h' | '7d'

/** One recorded bucket of host usage. `at` is unix seconds. */
export type HostPoint = {
	at: number
	cpu_percent: number
	memory_used: number
	memory_total: number
	disk_used: number
	disk_total: number
}

/** One recorded bucket of service usage; the byte counters are cumulative. */
export type ServicePoint = {
	at: number
	cpu_percent: number
	memory_usage: number
	memory_limit: number
	network_rx: number
	network_tx: number
	block_read: number
	block_write: number
}

export type CleanupPreview = {
	unused_images: number
	build_cache: number
	stopped_containers: number
	unused_volumes: number
	layers_size: number
}

export type VersionStatus = {
	current: string
	latest: string
	update_available: boolean
	checked_at: string
	/** GitHub release notes for `latest`; empty when no release is known. */
	release_url: string
} & VersionSettings

export type UpdatePhase = 'idle' | 'backup' | 'pulling' | 'restarting' | 'done' | 'rolled-back'

/**
 * Progress of an in-place update, written to disk by the updater so it
 * survives the manager restart the update itself causes.
 */
export type UpdateState = {
	phase: UpdatePhase
	target: string
	previous: string
	error: string
	/** Unix seconds of the last phase write. */
	at: number
	/** Updater container log tail, present after a rollback. */
	log?: string
}

/** Phases where the updater is still moving; done, rolled-back and idle are settled. */
export const updateActive = (phase: UpdatePhase | undefined) =>
	phase === 'backup' || phase === 'pulling' || phase === 'restarting'

/** Update preferences, stored server-side so they survive a reload. */
export type VersionSettings = {
	beta: boolean
	cleanup_old_images: boolean
}

export type Registry = {
	id: string
	name: string
	url: string
	username: string
	created_at: string
}

export type ApiToken = {
	id: string
	user_id: string
	name: string
	prefix: string
	last_used_at: string
	created_at: string
}

/** One entry of the built-in database catalog. */
export type Engine = {
	slug: string
	name: string
	/** Empty for the 'custom' engine, which has no curated image. */
	repository: string
	default_tag: string
	/** The offline list, shown before the live tag lookup answers. */
	versions: string[]
	port: number
	scheme: string
	database_var: string
	user_var: string
	password_var: string
}

/** The connection panel of a database service. */
export type DatabaseConnection = {
	engine: string
	image: string
	host: string
	port: number
	database: string
	user: string
	password: string
	url: string
	name: string
	versions: string[]
	data_volume: string
}

export type Settings = {
	dashboard_domain: string
	dashboard_https: boolean
	acme_email: string
	notify_webhook_url: string
	/** True when a Cloudflare token is stored. The token itself is never read back. */
	cloudflare_token_set: boolean
}

/** Omit cloudflare_api_token to keep the stored token, send '' to clear it. */
export type SettingsUpdate = Omit<Settings, 'cloudflare_token_set'> & {
	cloudflare_api_token?: string
}

export type AuditEntry = {
	id: string
	at: string
	actor: string
	method: string
	path: string
	status: number
	client_ip: string
	credential: string
}

export type Backup = {
	name: string
	path: string
	created_at: string
	size_bytes: number
	has_volumes: boolean
}

export type HealthReport = {
	status: 'healthy' | 'unhealthy'
	checks: Record<string, string>
}

/** The manager's uniform error envelope. */
export class ApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		readonly details?: Record<string, unknown>,
	) {
		super(message)
		this.name = 'ApiError'
	}
}

type RequestOptions = {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
	body?: unknown
	signal?: AbortSignal
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const method = options.method ?? 'GET'
	const headers: Record<string, string> = {}
	if (options.body !== undefined) headers['Content-Type'] = 'application/json'

	const response = await fetch(path, {
		method,
		headers,
		credentials: 'same-origin',
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: options.signal,
	})

	if (response.status === 204) return undefined as T

	const text = await response.text()
	// A proxy error page or a restarting manager can return non-JSON; surface
	// that as a normal ApiError instead of an unhandled parse exception.
	let payload: unknown
	if (text) {
		try {
			payload = JSON.parse(text)
		} catch {
			throw new ApiError('BAD_RESPONSE', text.slice(0, 200), response.status)
		}
	}

	if (!response.ok) {
		const envelope = payload as { error?: { code: string; message: string; details?: Record<string, unknown> } }
		throw new ApiError(
			envelope?.error?.code ?? 'UNKNOWN',
			envelope?.error?.message ?? response.statusText,
			response.status,
			envelope?.error?.details,
		)
	}
	return payload as T
}

/**
 * Project routes act on one environment. Leaving it off means the default one,
 * which is how a dashboard that has never heard of environments keeps working.
 */
function environmentQuery(environmentId?: string) {
	return environmentId ? `?environment=${environmentId}` : ''
}

export const api = {
	// Sign-in and sessions belong to better-auth (src/lib/auth-client.ts); this
	// is the manager's own view of the caller.
	me: () => request<{ user: User }>('/api/me'),

	projects: () => request<Project[]>('/api/projects'),
	project: (id: string) => request<Project>(`/api/projects/${id}`),
	createProject: (body: {
		name: string
		source_type: SourceType
		repository_url?: string
		branch?: string
		compose_path?: string
		compose_content?: string
		auto_deploy?: boolean
		tags?: string[]
		credential_kind?: CredentialKind
		credential_secret?: string
	}) => request<Project>('/api/projects', { method: 'POST', body }),
	updateProject: (
		id: string,
		body: Partial<{
			name: string
			/** Switching this empties the project's checkout. */
			source_type: SourceType
			branch: string
			compose_path: string
			repository_url: string
			auto_deploy: boolean
			tags: string[]
			credential_kind: CredentialKind
			credential_secret: string
			webhook_secret: string
		}>,
	) => request<Project>(`/api/projects/${id}`, { method: 'PATCH', body }),
	deleteProject: (id: string, removeVolumes: boolean) =>
		request<{ ok: boolean }>(`/api/projects/${id}?volumes=${removeVolumes}`, { method: 'DELETE' }),
	deploy: (id: string, environmentId?: string) =>
		request<Deployment>(`/api/projects/${id}/deploy${environmentQuery(environmentId)}`, { method: 'POST' }),
	/** Full-stack stop. Prefer serviceAction('stop') for one service. */
	stopProject: (id: string, environmentId?: string) =>
		request<{ ok: boolean }>(`/api/projects/${id}/stop${environmentQuery(environmentId)}`, { method: 'POST' }),
	compose: (id: string, environmentId?: string) =>
		request<{ content: string; path: string }>(`/api/projects/${id}/compose${environmentQuery(environmentId)}`),
	saveCompose: (id: string, content: string, environmentId?: string) =>
		request<{ ok: boolean }>(`/api/projects/${id}/compose${environmentQuery(environmentId)}`, {
			method: 'PUT',
			body: { content },
		}),
	/** The variables every environment of the project shares. */
	projectVariables: (id: string) => request<EnvVar[]>(`/api/projects/${id}/variables`),
	saveProjectVariables: (id: string, variables: EnvVar[]) =>
		request<EnvVar[]>(`/api/projects/${id}/variables`, { method: 'PUT', body: { variables } }),
	environments: (projectId: string) => request<Environment[]>(`/api/projects/${projectId}/environments`),
	createEnvironment: (projectId: string, body: { name: string; branch?: string }) =>
		request<Environment>(`/api/projects/${projectId}/environments`, { method: 'POST', body }),
	updateEnvironment: (id: string, body: Partial<{ name: string; branch: string }>) =>
		request<Environment>(`/api/environments/${id}`, { method: 'PATCH', body }),
	/** Stops the containers before dropping the record. The default one is refused. */
	deleteEnvironment: (id: string, removeVolumes: boolean) =>
		request<{ ok: boolean }>(`/api/environments/${id}?volumes=${removeVolumes}`, { method: 'DELETE' }),
	/** The variables that make this environment differ from its siblings. */
	environmentVariables: (id: string) => request<EnvVar[]>(`/api/environments/${id}/variables`),
	saveEnvironmentVariables: (id: string, variables: EnvVar[]) =>
		request<EnvVar[]>(`/api/environments/${id}/variables`, { method: 'PUT', body: { variables } }),
	services: (id: string, environmentId?: string) =>
		request<Service[]>(`/api/projects/${id}/services${environmentQuery(environmentId)}`),
	/**
	 * Adds a service the manager owns to a project. Passing `database` picks the
	 * catalog branch, which renders the image and seeds the credentials itself.
	 */
	createService: (
		projectId: string,
		body: {
			name: string
			source_type: Exclude<ServiceSource, 'derived'>
			repository_url?: string
			branch?: string
			build_path?: string
			image?: string
			compose_fragment?: string
			database?: {
				engine: string
				version?: string
				name?: string
				user?: string
				password?: string
				image?: string
				data_path?: string
			}
		},
		environmentId?: string,
	) =>
		request<Service>(`/api/projects/${projectId}/services${environmentQuery(environmentId)}`, {
			method: 'POST',
			body,
		}),
	/**
	 * Renders the project's managed services as base64 for another project's
	 * import. Secret values stay behind unless asked for: the blob is encoded,
	 * not encrypted, and it is headed for a clipboard.
	 */
	exportServices: (projectId: string, secrets: boolean, environmentId?: string) =>
		request<{ payload: string; secrets: boolean }>(
			`/api/projects/${projectId}/services/export?secrets=${secrets}${environmentId ? `&environment=${environmentId}` : ''}`,
		),
	deployments: (id: string, environmentId?: string) =>
		request<Deployment[]>(`/api/projects/${id}/deployments${environmentQuery(environmentId)}`),
	projectDomains: (id: string) => request<Domain[]>(`/api/projects/${id}/domains`),

	service: (id: string) => request<Service>(`/api/services/${id}`),
	updateService: (
		id: string,
		body: Partial<{
			display_name: string
			/** Only ever unconfigured -> git | image; a settled source is settled. */
			source_type: 'git' | 'image'
			repository_url: string
			branch: string
			build_path: string
			/** For a database this is the version switch: set it, then redeploy. */
			image: string
			compose_fragment: string
		}>,
	) => request<Service>(`/api/services/${id}`, { method: 'PATCH', body }),
	/** The named volume survives; dropping a database's data stays explicit. */
	deleteService: (id: string) => request<undefined>(`/api/services/${id}`, { method: 'DELETE' }),
	serviceDatabase: (id: string) => request<DatabaseConnection>(`/api/services/${id}/database`),
	serviceVariables: (id: string) => request<EnvVar[]>(`/api/services/${id}/variables`),
	saveServiceVariables: (id: string, variables: EnvVar[]) =>
		request<undefined>(`/api/services/${id}/variables`, { method: 'PUT', body: { variables } }),
	serviceMetrics: (id: string, window: MetricWindow = '30m') =>
		request<ServicePoint[]>(`/api/services/${id}/metrics?window=${window}`),
	deployService: (id: string) => request<Deployment>(`/api/services/${id}/deploy`, { method: 'POST' }),
	serviceAction: (id: string, action: 'start' | 'stop' | 'restart') =>
		request<{ ok: boolean }>(`/api/services/${id}/${action}`, { method: 'POST' }),

	tasks: () => request<ScheduledTask[]>('/api/tasks'),
	serviceTasks: (id: string) => request<ScheduledTask[]>(`/api/services/${id}/tasks`),
	createTask: (serviceId: string, body: TaskInput) =>
		request<ScheduledTask>(`/api/services/${serviceId}/tasks`, { method: 'POST', body }),
	updateTask: (id: string, body: Partial<TaskInput>) =>
		request<ScheduledTask>(`/api/tasks/${id}`, { method: 'PATCH', body }),
	deleteTask: (id: string) => request<undefined>(`/api/tasks/${id}`, { method: 'DELETE' }),
	/** Runs the task now and resolves with the finished run, exit code and all. */
	runTask: (id: string) => request<TaskRun>(`/api/tasks/${id}/run`, { method: 'POST' }),
	taskRuns: (id: string) => request<TaskRun[]>(`/api/tasks/${id}/runs`),

	domains: () => request<Domain[]>('/api/domains'),
	createDomain: (body: {
		project_id: string
		/** Which copy of the project serves it. Omitted means the default one. */
		environment_id?: string
		service: string
		hostname: string
		container_port: number
		https_enabled: boolean
		redirect_https: boolean
		certificate_source?: CertificateSource
		certificate_pem?: string
		private_key_pem?: string
		analytics?: boolean
	}) => request<{ domain: Domain; warning?: string }>('/api/domains', { method: 'POST', body }),
	updateDomain: (
		id: string,
		body: Partial<{
			hostname: string
			container_port: number
			https_enabled: boolean
			redirect_https: boolean
			certificate_source: CertificateSource
			certificate_pem: string
			private_key_pem: string
			analytics: boolean
		}>,
	) => request<{ domain: Domain; warning?: string }>(`/api/domains/${id}`, { method: 'PATCH', body }),
	deleteDomain: (id: string) => request<{ ok: boolean }>(`/api/domains/${id}`, { method: 'DELETE' }),
	issueCertificate: (id: string) => request<Certificate>(`/api/domains/${id}/certificate`, { method: 'POST' }),

	analytics: (hostname: string, range: AnalyticsRange) =>
		request<{ domain: Domain; traffic: Traffic }>(`/api/analytics/${hostname}?range=${range}`),
	/** Four weeks of hourly buckets, for the weekday heatmap. */
	analyticsActivity: (hostname: string) => request<{ series: TrafficPoint[] }>(`/api/analytics/${hostname}/activity`),
	clearAnalytics: (hostname: string) =>
		request<{ deleted: number }>(`/api/analytics/${hostname}`, { method: 'DELETE' }),

	deployment: (id: string) => request<{ deployment: Deployment; steps: DeploymentStep[] }>(`/api/deployments/${id}`),
	cancelDeployment: (id: string) => request<{ ok: boolean }>(`/api/deployments/${id}/cancel`, { method: 'POST' }),
	rollback: (id: string) => request<Deployment>(`/api/deployments/${id}/rollback`, { method: 'POST' }),

	containers: () => request<ContainerSummary[]>('/api/docker/containers'),
	containerAction: (id: string, action: ContainerAction) =>
		request<{ ok: boolean }>(`/api/docker/containers/${id}/${action}`, { method: 'POST' }),
	images: () => request<ImageSummary[]>('/api/docker/images'),
	pullImage: (reference: string) =>
		request<{ output: string }>('/api/docker/images/pull', { method: 'POST', body: { reference } }),
	removeImage: (id: string, force: boolean) =>
		request<{ ok: boolean }>(`/api/docker/images/${encodeURIComponent(id)}?force=${force}`, { method: 'DELETE' }),
	volumes: () => request<VolumeSummary[]>('/api/docker/volumes'),
	removeVolume: (name: string) =>
		request<{ ok: boolean }>(`/api/docker/volumes/${encodeURIComponent(name)}?confirm=true`, { method: 'DELETE' }),
	networks: () => request<NetworkSummary[]>('/api/docker/networks'),
	cleanupPreview: () => request<CleanupPreview>('/api/docker/cleanup'),
	cleanup: (kind: 'containers' | 'images' | 'volumes' | 'networks' | 'build-cache') =>
		request<{ kind: string; removed: number; space_reclaimed: number }>(
			// An unused volume is a stopped project's data, so the manager wants the
			// same confirmation here as it does for removing one by name.
			`/api/docker/cleanup/${kind}${kind === 'volumes' ? '?confirm=true' : ''}`,
			{ method: 'POST' },
		),

	registries: () => request<Registry[]>('/api/registries'),
	createRegistry: (body: { name: string; url: string; username: string; password: string }) =>
		request<Registry>('/api/registries', { method: 'POST', body }),
	deleteRegistry: (id: string) => request<{ ok: boolean }>(`/api/registries/${id}`, { method: 'DELETE' }),

	tokens: () => request<ApiToken[]>('/api/tokens'),
	createToken: (name: string) =>
		request<{ token: ApiToken; value: string }>('/api/tokens', { method: 'POST', body: { name } }),
	deleteToken: (id: string) => request<{ ok: boolean }>(`/api/tokens/${id}`, { method: 'DELETE' }),

	engines: () => request<Engine[]>('/api/engines'),
	engineVersions: (slug: string) => request<{ versions: string[]; live: boolean }>(`/api/engines/${slug}/versions`),

	systemInfo: () => request<SystemInfo>('/api/system/info'),
	systemMetrics: (window: MetricWindow = '30m') => request<HostPoint[]>(`/api/system/metrics?window=${window}`),
	settings: () => request<Settings>('/api/system/settings'),
	saveSettings: (body: SettingsUpdate) => request<Settings>('/api/system/settings', { method: 'PUT', body }),
	certificates: () => request<Certificate[]>('/api/system/certificates'),
	audit: () => request<AuditEntry[]>('/api/system/audit'),
	backups: () => request<Backup[]>('/api/system/backups'),
	createBackup: (includeVolumes = false) =>
		request<Backup>(`/api/system/backup?volumes=${includeVolumes}`, { method: 'POST' }),
	version: () => request<VersionStatus>('/api/system/version'),
	setVersionSettings: (settings: VersionSettings) =>
		request<VersionStatus>('/api/system/version', { method: 'PUT', body: settings }),
	update: (version: string | undefined) =>
		request<{ status: string; message: string }>('/api/system/update', {
			method: 'POST',
			body: { version: version ?? '' },
		}),
	updateState: () => request<UpdateState>('/api/system/update/status'),
	// Not request(): an unhealthy platform answers 503 and the checks in that
	// body are exactly what the caller wants to render.
	health: async (): Promise<HealthReport> => {
		const response = await fetch('/api/health', { credentials: 'same-origin' })
		return (await response.json()) as HealthReport
	},
}
