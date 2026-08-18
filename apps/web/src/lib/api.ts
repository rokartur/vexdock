/**
 * Typed client for the Go manager API.
 *
 * The CSRF token is captured on login/session bootstrap and replayed on every
 * mutation, matching what the manager enforces for cookie sessions.
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
	created_at: string
	updated_at: string
}

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
	git_credential_kind: CredentialKind
	created_at: string
	updated_at: string
	service_count: number
	running_count: number
	domains: Domain[]
	latest_deployment: Deployment | null
	webhook_url: string
	webhook_secret_set: boolean
}

export type Service = {
	id: string
	project_id: string
	compose_service_name: string
	display_name: string
	created_at: string
	container_id: string
	state: string
	status: string
	image: string
	health: string
	restart_count: number
	created_unix: number
}

export type EnvVar = {
	key: string
	value: string
	is_secret: boolean
	updated_at: string
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

export type ImageSummary = {
	Id: string
	RepoTags: string[] | null
	RepoDigests: string[] | null
	Created: number
	Size: number
	Containers: number
}

export type VolumeSummary = {
	Name: string
	Driver: string
	Mountpoint: string
	CreatedAt: string
	Labels: Record<string, string> | null
	UsageData?: { Size: number; RefCount: number } | null
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

export type Template = {
	slug: string
	name: string
	description: string
	compose: string
}

export type Settings = {
	dashboard_domain: string
	dashboard_https: boolean
	acme_email: string
	notify_webhook_url: string
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
		template?: string
		auto_deploy?: boolean
		credential_kind?: CredentialKind
		credential_secret?: string
	}) => request<Project>('/api/projects', { method: 'POST', body }),
	updateProject: (
		id: string,
		body: Partial<{
			name: string
			branch: string
			compose_path: string
			repository_url: string
			auto_deploy: boolean
			credential_kind: CredentialKind
			credential_secret: string
			webhook_secret: string
		}>,
	) => request<Project>(`/api/projects/${id}`, { method: 'PATCH', body }),
	deleteProject: (id: string, removeVolumes: boolean) =>
		request<{ ok: boolean }>(`/api/projects/${id}?volumes=${removeVolumes}`, { method: 'DELETE' }),
	deploy: (id: string) => request<Deployment>(`/api/projects/${id}/deploy`, { method: 'POST' }),
	stopProject: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}/stop`, { method: 'POST' }),
	compose: (id: string) => request<{ content: string; path: string }>(`/api/projects/${id}/compose`),
	saveCompose: (id: string, content: string) =>
		request<{ ok: boolean }>(`/api/projects/${id}/compose`, { method: 'PUT', body: { content } }),
	environment: (id: string) => request<EnvVar[]>(`/api/projects/${id}/environment`),
	saveEnvironment: (id: string, variables: EnvVar[]) =>
		request<EnvVar[]>(`/api/projects/${id}/environment`, { method: 'PUT', body: { variables } }),
	services: (id: string) => request<Service[]>(`/api/projects/${id}/services`),
	deployments: (id: string) => request<Deployment[]>(`/api/projects/${id}/deployments`),
	projectDomains: (id: string) => request<Domain[]>(`/api/projects/${id}/domains`),

	service: (id: string) => request<Service>(`/api/services/${id}`),
	serviceAction: (id: string, action: 'start' | 'stop' | 'restart') =>
		request<{ ok: boolean }>(`/api/services/${id}/${action}`, { method: 'POST' }),

	domains: () => request<Domain[]>('/api/domains'),
	createDomain: (body: {
		project_id: string
		service: string
		hostname: string
		container_port: number
		https_enabled: boolean
		redirect_https: boolean
		certificate_source?: CertificateSource
		certificate_pem?: string
		private_key_pem?: string
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
		}>,
	) => request<{ domain: Domain; warning?: string }>(`/api/domains/${id}`, { method: 'PATCH', body }),
	deleteDomain: (id: string) => request<{ ok: boolean }>(`/api/domains/${id}`, { method: 'DELETE' }),
	issueCertificate: (id: string) => request<Certificate>(`/api/domains/${id}/certificate`, { method: 'POST' }),

	deployment: (id: string) => request<{ deployment: Deployment; steps: DeploymentStep[] }>(`/api/deployments/${id}`),
	cancelDeployment: (id: string) => request<{ ok: boolean }>(`/api/deployments/${id}/cancel`, { method: 'POST' }),
	rollback: (id: string) => request<Deployment>(`/api/deployments/${id}/rollback`, { method: 'POST' }),

	containers: () => request<ContainerSummary[]>('/api/docker/containers'),
	containerAction: (id: string, action: 'start' | 'stop' | 'restart' | 'remove') =>
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
		request<{ kind: string; removed: number; space_reclaimed: number }>(`/api/docker/cleanup/${kind}`, {
			method: 'POST',
		}),

	registries: () => request<Registry[]>('/api/registries'),
	createRegistry: (body: { name: string; url: string; username: string; password: string }) =>
		request<Registry>('/api/registries', { method: 'POST', body }),
	deleteRegistry: (id: string) => request<{ ok: boolean }>(`/api/registries/${id}`, { method: 'DELETE' }),

	tokens: () => request<ApiToken[]>('/api/tokens'),
	createToken: (name: string) =>
		request<{ token: ApiToken; value: string }>('/api/tokens', { method: 'POST', body: { name } }),
	deleteToken: (id: string) => request<{ ok: boolean }>(`/api/tokens/${id}`, { method: 'DELETE' }),

	templates: () => request<Template[]>('/api/templates'),

	systemInfo: () => request<SystemInfo>('/api/system/info'),
	settings: () => request<Settings>('/api/system/settings'),
	saveSettings: (body: Settings) => request<Settings>('/api/system/settings', { method: 'PUT', body }),
	certificates: () => request<Certificate[]>('/api/system/certificates'),
	audit: () => request<AuditEntry[]>('/api/system/audit'),
	backups: () => request<Backup[]>('/api/system/backups'),
	createBackup: () => request<Backup>('/api/system/backup', { method: 'POST' }),
	version: () => request<VersionStatus>('/api/system/version'),
	update: (version?: string) =>
		request<{ status: string; message: string }>('/api/system/update', {
			method: 'POST',
			body: { version: version ?? '' },
		}),
	health: () => request<HealthReport>('/api/health'),
}
