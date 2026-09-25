#!/usr/bin/env bun
// Moves one Dokploy project, named volumes included, onto a vexdock server.
// Usage: bun scripts/migrate-dokploy.ts "<dokploy project name>"
// Env: DOKPLOY_URL DOKPLOY_API_KEY VEXDOCK_URL VEXDOCK_TOKEN, VEXDOCK_GIT_PROVIDER for github sources,
//      DOKPLOY_SSH VEXDOCK_SSH only when an app or compose has a named volume
import { $ } from 'bun'

type DokployDomain = {
	host: string
	path: string | null
	port: number | null
	https: boolean
	serviceName: string | null
}
type DokployMount = { type: string; volumeName: string | null; mountPath: string }
type DokployApp = {
	applicationId: string
	name: string
	sourceType: string
	buildType: string
	owner: string | null
	repository: string | null
	branch: string | null
	buildPath: string | null
	dockerfile: string | null
	dockerImage: string | null
	env: string | null
	buildArgs: string | null
	domains: DokployDomain[]
	mounts: DokployMount[]
}
type DokployCompose = {
	composeId: string
	name: string
	appName: string
	sourceType: string
	composeFile: string
	env: string | null
	domains: DokployDomain[]
}
type DokployPostgres = {
	postgresId: string
	name: string
	appName: string
	dockerImage: string
	databaseName: string
	databaseUser: string
	databasePassword: string
	externalPort: number | null
}
type DokployEnvironment = {
	applications: { applicationId: string }[]
	compose: { composeId: string }[]
	postgres: { postgresId: string }[]
	mysql: unknown[]
	mariadb: unknown[]
	mongo: unknown[]
	redis: unknown[]
	libsql: unknown[]
}
type VexdockProject = {
	id: string
	environments: { id: string; compose_project_name: string; is_default: boolean }[]
}
type VexdockService = { id: string; compose_service_name: string }
type VolumeCopy = { from: string; to: string }

const projectName = process.argv[2]
if (!projectName) throw new Error('usage: bun scripts/migrate-dokploy.ts "<dokploy project name>"')
const env = (key: string) => {
	const value = process.env[key]
	if (!value) throw new Error(`${key} is not set`)
	return value
}
type DatabaseDump = { serviceId: string; name: string; port: number }

const dokployUrl = env('DOKPLOY_URL').replace(/\/$/, '')
const dokployKey = env('DOKPLOY_API_KEY')
const vexdockUrl = env('VEXDOCK_URL').replace(/\/$/, '')
const vexdockToken = env('VEXDOCK_TOKEN')

const source = await readDokployProject(projectName)
const project = await vexdock<VexdockProject>('POST', '/api/projects', { name: projectName })
const environment = defaultEnvironment(project)
const volumePrefix = `${environment.compose_project_name}_`
const copies: VolumeCopy[] = []
const dumps: DatabaseDump[] = []
const skipped: string[] = []
// Dokploy's database hostname (its appName) -> the vexdock service name, rewritten in every .env.
const renamedHosts = new Map<string, string>()

if (source.composes.filter(c => c.env?.trim()).length > 1)
	throw new Error('more than one compose has a .env; vexdock shares one per environment')
for (const pg of source.postgres) await createPostgres(pg)
for (const app of source.apps) await createApp(app)
for (const compose of source.composes) await createCompose(compose)
// Only plain volumes cross over ssh; databases travel as a dump through their published port.
const dokploySsh = copies.length > 0 ? env('DOKPLOY_SSH') : ''
const vexdockSsh = copies.length > 0 ? env('VEXDOCK_SSH') : ''
const dokployIp = await dokploy<string>('GET', 'settings.getIp')

console.log(`stopping ${projectName}'s applications on Dokploy`)
for (const app of source.apps) await dokploy('POST', 'application.stop', { applicationId: app.applicationId })
for (const compose of source.composes) await dokploy('POST', 'compose.stop', { composeId: compose.composeId })

for (const copy of copies) await copyVolume(copy)
for (const dump of dumps) await restoreDump(dump)
for (const pg of source.postgres) await dokploy('POST', 'postgres.stop', { postgresId: pg.postgresId })

console.log('deploying on vexdock')
await vexdock('POST', `/api/projects/${project.id}/deploy`)
for (const line of skipped) console.warn(`skipped: ${line}`)
console.log(`done. Point the domains' DNS at the vexdock server; Dokploy's copy is stopped, not deleted.`)

function defaultEnvironment(created: VexdockProject) {
	const found = created.environments.find(e => e.is_default)
	if (!found) throw new Error('the new vexdock project has no default environment')
	return found
}

async function readDokployProject(name: string) {
	const all = await dokploy<{ name: string; environments: DokployEnvironment[] }[]>('GET', 'project.all')
	const found = all.find(p => p.name === name)
	if (!found) throw new Error(`no Dokploy project named ${name}`)
	const [dokployEnv, ...others] = found.environments
	if (!dokployEnv || others.length > 0) throw new Error('only single-environment Dokploy projects are supported')
	for (const kind of ['mysql', 'mariadb', 'mongo', 'redis', 'libsql'] as const) {
		if (dokployEnv[kind].length > 0) throw new Error(`${kind} databases are not migrated yet`)
	}
	const apps: DokployApp[] = []
	for (const { applicationId } of dokployEnv.applications)
		apps.push(await dokploy('GET', 'application.one', { applicationId }))
	const composes: DokployCompose[] = []
	for (const { composeId } of dokployEnv.compose) composes.push(await dokploy('GET', 'compose.one', { composeId }))
	const postgres: DokployPostgres[] = []
	for (const { postgresId } of dokployEnv.postgres)
		postgres.push(await dokploy('GET', 'postgres.one', { postgresId }))
	return { apps, composes, postgres }
}

async function createApp(app: DokployApp) {
	if (app.buildType !== 'dockerfile' && app.sourceType !== 'docker')
		throw new Error(`${app.name}: build type ${app.buildType} has no vexdock equivalent`)
	if (app.buildArgs?.trim()) throw new Error(`${app.name}: build args have no vexdock equivalent`)
	const created = await vexdock<VexdockService>('POST', `/api/projects/${project.id}/services`, appSource(app))
	const mounts: string[] = []
	for (const mount of app.mounts) {
		if (mount.type !== 'volume' || !mount.volumeName)
			throw new Error(
				`${app.name}: only named volume mounts are migrated, not ${mount.type} at ${mount.mountPath}`,
			)
		mounts.push(`${mount.volumeName}:${mount.mountPath}`)
		copies.push({ from: mount.volumeName, to: volumePrefix + mount.volumeName })
	}
	await vexdock('PATCH', `/api/services/${created.id}`, {
		dockerfile: app.dockerfile ?? '',
		mounts: mounts.join('\n'),
	})
	await putVariables(`/api/services/${created.id}/variables`, app.env)
	await createDomains(created.compose_service_name, app.domains)
}

function appSource(app: DokployApp) {
	if (app.sourceType === 'docker') return { name: app.name, provider: 'image', image: app.dockerImage }
	if (app.sourceType !== 'github') throw new Error(`${app.name}: source ${app.sourceType} is not migrated yet`)
	return {
		name: app.name,
		provider: 'github',
		git_provider_id: env('VEXDOCK_GIT_PROVIDER'),
		owner: app.owner,
		repository: app.repository,
		branch: app.branch,
		build_path: app.buildPath ?? '',
	}
}

async function createCompose(compose: DokployCompose) {
	if (compose.sourceType !== 'raw') throw new Error(`${compose.name}: only pasted compose files are migrated`)
	const file = Bun.YAML.parse(compose.composeFile) as { services: Record<string, Record<string, unknown>> }
	// A raw fragment's env_file: .env resolves to the environment's variables, not the service's.
	await putVariables(`/api/projects/${project.id}/variables?environment=${environment.id}`, compose.env)
	for (const [serviceName, body] of Object.entries(file.services)) {
		const created = await vexdock<VexdockService>('POST', `/api/projects/${project.id}/services`, {
			name: serviceName,
			provider: 'raw',
			compose_fragment: rawFragment(body),
		})
		for (const volume of namedVolumes(body)) {
			copies.push({ from: `${compose.appName}_${volume}`, to: volumePrefix + volume })
		}
		await createDomains(
			created.compose_service_name,
			compose.domains.filter(d => d.serviceName === serviceName),
		)
	}
}

// Traefik labels, dokploy-network and a fixed container_name belong to Dokploy's proxy and naming.
function rawFragment(body: Record<string, unknown>) {
	const { labels, networks, container_name: _, ...rest } = body
	if (Array.isArray(labels)) {
		const kept = labels.filter(l => typeof l === 'string' && !l.startsWith('traefik.'))
		if (kept.length > 0) rest.labels = kept
	} else if (labels && typeof labels === 'object') {
		const kept = Object.fromEntries(Object.entries(labels).filter(([k]) => !k.startsWith('traefik.')))
		if (Object.keys(kept).length > 0) rest.labels = kept
	}
	const custom = Array.isArray(networks) ? networks.filter(n => n !== 'dokploy-network' && n !== 'default') : networks
	if (Array.isArray(custom) ? custom.length > 0 : custom) {
		skipped.push(`networks ${JSON.stringify(networks)} dropped; vexdock puts every service on its project network`)
	}
	return Bun.YAML.stringify(rest, null, 2)
		.split('\n')
		.map(line => line.trimEnd())
		.join('\n')
}

function namedVolumes(body: Record<string, unknown>) {
	const names: string[] = []
	for (const entry of (body.volumes as unknown[] | undefined) ?? []) {
		const volume = typeof entry === 'string' ? entry.split(':')[0] : (entry as { source?: string }).source
		if (volume && !volume.startsWith('.') && !volume.startsWith('/')) names.push(volume)
	}
	return names
}

async function createPostgres(pg: DokployPostgres) {
	const [, tag] = pg.dockerImage.split(':')
	if (!tag) throw new Error(`${pg.name}: image ${pg.dockerImage} has no version tag`)
	if (!pg.externalPort) throw new Error(`${pg.name}: set an external port in Dokploy, the dump reads through it`)
	const created = await vexdock<VexdockService>('POST', `/api/projects/${project.id}/services`, {
		name: pg.name,
		database: {
			engine: 'postgres',
			version: tag,
			name: pg.databaseName,
			user: pg.databaseUser,
			password: pg.databasePassword,
		},
	})
	dumps.push({ serviceId: created.id, name: pg.name, port: pg.externalPort })
	renamedHosts.set(pg.appName, created.compose_service_name)
	await vexdock('POST', `/api/services/${created.id}/ports`, {
		published: pg.externalPort,
		target: 5432,
		protocol: 'tcp',
	})
}

// Same user, password and database on both sides, so the container's own env logs in to Dokploy too.
async function restoreDump({ serviceId, name, port }: DatabaseDump) {
	console.log(`restoring ${name} from ${dokployIp}:${port}`)
	const deploy = await vexdock<{ id: string; status: string }>('POST', `/api/services/${serviceId}/deploy`)
	let status = deploy.status
	while (status === 'queued' || status === 'running') {
		await Bun.sleep(2000)
		status = (await vexdock<{ deployment: { status: string } }>('GET', `/api/deployments/${deploy.id}`)).deployment
			.status
	}
	if (status !== 'success') throw new Error(`${name}: deploy ${deploy.id} ended ${status}`)
	// The entrypoint's init server listens on the socket only, so a TCP answer means the final server is up.
	const command = [
		'set -o pipefail',
		'until pg_isready -q -h 127.0.0.1; do sleep 1; done',
		'export PGPASSWORD="$POSTGRES_PASSWORD"',
		`pg_dump -h ${dokployIp} -p ${port} -U "$POSTGRES_USER" -d "$POSTGRES_DB" | psql -q -o /dev/null -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"`,
	].join('\n')
	const result = await vexdock<{ exit_code: number; output: string }>('POST', `/api/services/${serviceId}/exec`, {
		command,
	})
	if (result.exit_code !== 0) throw new Error(`${name}: restore exited ${result.exit_code}\n${result.output}`)
}

async function putVariables(path: string, dotenv: string | null) {
	const variables: { key: string; value: string; is_secret: boolean }[] = []
	let text = dotenv ?? ''
	for (const [from, to] of renamedHosts) text = text.replaceAll(from, to)
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const at = trimmed.indexOf('=')
		if (at < 1) throw new Error(`unparseable env line: ${trimmed.slice(0, 40)}`)
		variables.push({ key: trimmed.slice(0, at), value: trimmed.slice(at + 1), is_secret: true })
	}
	if (variables.length > 0) await vexdock('PUT', path, { variables })
}

async function createDomains(service: string, domains: DokployDomain[]) {
	for (const domain of domains) {
		if (domain.path && domain.path !== '/') {
			skipped.push(`${domain.host}${domain.path} -> ${service}: vexdock routes whole hostnames, not paths`)
			continue
		}
		await vexdock('POST', '/api/domains', {
			project_id: project.id,
			environment_id: environment.id,
			service,
			hostname: domain.host,
			container_port: domain.port ?? 80,
			https_enabled: domain.https,
			redirect_https: domain.https,
		})
	}
}

// Streams tar over both ssh sessions; the volume is created with compose's labels so the deploy adopts it.
async function copyVolume({ from, to }: VolumeCopy) {
	console.log(`copying volume ${from} -> ${to}`)
	await $`ssh ${dokploySsh} docker volume inspect ${from}`.quiet()
	const composeVolume = to.slice(volumePrefix.length)
	await $`ssh ${vexdockSsh} docker volume create --label com.docker.compose.project=${environment.compose_project_name} --label com.docker.compose.volume=${composeVolume} ${to}`.quiet()
	await $`ssh ${dokploySsh} docker run --rm -v ${from}:/from:ro alpine tar -C /from -cf - . | ssh ${vexdockSsh} docker run --rm -i -v ${to}:/to alpine tar -C /to -xpf -`
}

async function dokploy<T>(method: 'GET' | 'POST', procedure: string, input: Record<string, string> = {}) {
	const url = new URL(`${dokployUrl}/api/${procedure}`)
	if (method === 'GET') for (const [k, v] of Object.entries(input)) url.searchParams.set(k, v)
	const res = await fetch(url, {
		method,
		headers: { 'x-api-key': dokployKey, 'content-type': 'application/json' },
		body: method === 'POST' ? JSON.stringify(input) : undefined,
	})
	if (!res.ok) throw new Error(`Dokploy ${procedure}: ${res.status} ${await res.text()}`)
	return (await res.json()) as T
}

async function vexdock<T>(method: string, path: string, body?: unknown) {
	const res = await fetch(`${vexdockUrl}${path}`, {
		method,
		headers: { authorization: `Bearer ${vexdockToken}`, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`vexdock ${method} ${path}: ${res.status} ${await res.text()}`)
	if (res.status === 204) return undefined as T
	return (await res.json()) as T
}
