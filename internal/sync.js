/**
 * Sync orchestration: discover, plan, verify, publish.
 *
 * The plan is always computed before anything is published, and it is what both
 * the preview tool and the push tool render, so what a human approves is exactly
 * what runs. Every step is idempotent — publishing always produces a fresh
 * single-commit snapshot — so a retry after a partial failure is safe.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { STATUS_FILE, USER_CONFIG } from './config.js'
import { discoverPlugins } from './discover.js'
import { createRepository, describeRepository, setTopics, whoAmI } from './github.js'
import { publish } from './git.js'
import { buildManifest } from './manifest.js'

/** Terminal states a plugin's sync can end in. */
export const OUTCOMES = ['pushed', 'unchanged', 'created+pushed', 'planned', 'skipped', 'failed']

/**
 * The directories searched for plugins, in priority order.
 *
 * @param {ResolvedConfig} config - the resolved configuration.
 * @param {string | undefined} cwd - the requesting session's working directory.
 * @returns {string[]} absolute scan roots, deduplicated.
 */
export function scanRoots(config, cwd) {
	const roots = []
	for (const candidate of [cwd, config.workspaceRoot, ...config.pluginDirs]) {
		if (typeof candidate !== 'string' || candidate.trim() === '') continue
		const value = candidate.trim()
		if (!roots.some((existing) => existing.toLowerCase() === value.toLowerCase())) roots.push(value)
	}
	return roots
}

/**
 * Render a commit subject from the configured template.
 *
 * @param {string} template - template with `{name}`, `{version}`, `{repo}`, `{stamp}`.
 * @param {DiscoveredPlugin} plugin - the plugin being published.
 * @returns {string} the commit subject.
 */
function commitMessage(template, plugin) {
	return String(template)
		.replace(/\{name\}/g, plugin.name ?? plugin.repo)
		.replace(/\{version\}/g, plugin.version ?? '0.0.0')
		.replace(/\{repo\}/g, plugin.repo)
		.replace(/\{stamp\}/g, new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z')
}

/**
 * Format a byte count for human eyes.
 *
 * @param {number} bytes - the count.
 * @returns {string} a short human-readable size.
 */
export function humanBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

/**
 * Whether the git executable is reachable at all.
 *
 * @param {string} executable - configured executable name or path.
 * @returns {{ ok: boolean, resolved?: string, hint?: string }} the probe result.
 */
export function resolveGit(executable) {
	const names = process.platform === 'win32' && !executable.includes('/') && !executable.includes('\\') ? [`${executable}.exe`, executable] : [executable]
	const pathEntries = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry !== '')
	for (const name of names) {
		if (name.includes('/') || name.includes('\\')) {
			// A path-shaped executable needs a real existence check, which the first
			// git invocation performs; report it as plausible here.
			return { ok: true, resolved: name }
		}
		for (const entry of pathEntries) {
			const candidate = join(entry, name)
			if (existsSync(candidate)) return { ok: true, resolved: candidate }
		}
	}
	return {
		ok: false,
		hint: `在 PATH 里找不到「${executable}」。装好 Git for Windows 后重启应用，或在 sync.config.json 的 git.executable 写完整路径（例如 C:\\Program Files\\Git\\cmd\\git.exe）。`,
	}
}

/**
 * Build the sync plan: one entry per discovered plugin, with its manifest and
 * every problem that would stop it, but no side effects at all.
 *
 * @param {object} options - plan inputs.
 * @param {ResolvedConfig} options.config - resolved configuration.
 * @param {string | undefined} options.cwd - the requesting session's workspace.
 * @param {string[]} [options.only] - publish only these plugin keys or repository names.
 * @returns {{ roots: { path: string, exists: boolean }[], entries: PlanEntry[], problems: string[] }} the plan.
 */
export function plan({ config, cwd, only }) {
	const roots = scanRoots(config, cwd)
	const discovery = discoverPlugins({ roots, plugins: config.plugins })
	const problems = []

	const wanted = Array.isArray(only) ? only.map((value) => String(value).trim()).filter((value) => value !== '') : []
	const selected = []
	for (const plugin of discovery.plugins) {
		if (wanted.length === 0) {
			selected.push(plugin)
			continue
		}
		const matches = wanted.some(
			(value) =>
				value === plugin.key ||
				value === plugin.repo ||
				value === plugin.dirName ||
				value === plugin.name ||
				value === plugin.configKey,
		)
		if (matches) selected.push(plugin)
	}
	if (wanted.length > 0 && selected.length === 0) {
		problems.push(`没有匹配的插件：${wanted.join('、')}（可用名称见 github_sync_status 的插件清单）`)
	}
	const unmatched = wanted.filter(
		(value) => !discovery.plugins.some((plugin) => [plugin.key, plugin.repo, plugin.dirName, plugin.name, plugin.configKey].includes(value)),
	)
	for (const value of unmatched) problems.push(`未知插件：${value}`)

	/** @type {PlanEntry[]} */
	const entries = []
	for (const plugin of selected) {
		const manifest = buildManifest({
			dir: plugin.dir,
			entry: plugin.entry,
			excludeNames: config.excludeNames,
			excludePatterns: config.excludePatterns,
		})
		const entry = {
			plugin,
			manifest,
			repository: config.github.owner === '' ? undefined : `${config.github.owner}/${plugin.repo}`,
			visibility: plugin.visibility ?? config.visibility,
			topics: Array.isArray(plugin.entry?.topics) ? plugin.entry.topics : config.github.topics,
			blockers: [],
			skipReason: undefined,
		}
		if (!plugin.enabled) entry.skipReason = '在 sync.config.json 里被 enabled: false 关掉了'
		if (config.github.owner === '') entry.blockers.push('没有配置 GitHub 账号：在 %USERPROFILE%\\.dsh\\github-sync\\config.json 里填 github.owner')
		// DSH convention: the plugin folder carries the dsh- prefix, and the
		// repository takes its name from that folder. A folder that breaks the
		// convention would publish a repository that no longer reads as a DSH
		// plugin, so it is refused rather than renamed silently. An explicit
		// `plugins.<name>.repo` counts as a deliberate exception and is left alone.
		if (plugin.folderPrefixOk === false && plugin.repoFrom === 'folder-name') {
			entry.blockers.push(
				`插件文件夹名不符合 DSH 约定：目录「${plugin.dirName}」缺少 dsh- 前缀。` +
					`把文件夹改名为「${plugin.suggestedName}」后，仓库名会自动变成该名字；` +
					`若这是有意的例外，请在 sync.config.json 里显式写 plugins「${plugin.configKey ?? plugin.dirName}」的 repo。`,
			)
		}
		if (manifest.files.length === 0) entry.blockers.push('干净副本为空：检查该插件的 include 白名单或排除规则')
		if (manifest.notes.length > 0) entry.blockers.push(...manifest.notes)
		entries.push(entry)
	}

	return { roots: discovery.roots, entries, problems, pluginCount: discovery.plugins.length }
}

/**
 * Publish every planned entry.
 *
 * @param {object} options - push inputs.
 * @param {ResolvedConfig} options.config - resolved configuration.
 * @param {ReturnType<typeof plan>} options.plan - the plan to execute.
 * @param {boolean} [options.dryRun] - stage and commit without pushing.
 * @param {boolean} [options.createRepos] - create missing repositories through the API.
 * @param {boolean} [options.verify] - check each repository through the API first.
 * @returns {Promise<{ results: PushResult[], warnings: string[], identity?: { login: string, type: string } }>} the outcome.
 */
export async function execute({ config, plan: planValue, dryRun = false, createRepos = true, verify = true }) {
	const warnings = []
	const gitProbe = resolveGit(config.git.executable)
	if (!gitProbe.ok) throw new Error(gitProbe.hint)

	const token = config.github.token
	const needApi = !dryRun && config.github.owner !== '' && (verify || createRepos)
	if (needApi && (typeof token !== 'string' || token.trim() === '')) {
		throw new Error(
			'没有可用的 GitHub token。\n' +
				`把 token 写进 ${USER_CONFIG} 的 github.token，或设置环境变量 GITHUB_TOKEN，然后重试。\n` +
				'fine-grained token 需要 Contents: Read and write（推送），建仓库还需要 Administration: Read and write。',
		)
	}

	let identity
	if (needApi) {
		identity = await whoAmI({ apiBase: config.github.apiBase, token })
		if (config.github.owner !== '' && identity.login.toLowerCase() !== config.github.owner.toLowerCase() && config.github.accountType !== 'org') {
			warnings.push(
				`配置的 github.owner 是 ${config.github.owner}，但 token 属于 ${identity.login}。` +
					`推送会写到 token 拥有写权限的 ${config.github.owner}，如果不是你想要的，请改配置。`,
			)
		}
	}

	/** @type {PushResult[]} */
	const results = []
	for (const entry of planValue.entries) {
		const { plugin, manifest } = entry
		const record = {
			plugin: plugin.repo,
			package: plugin.name,
			directory: plugin.dir,
			repository: entry.repository,
			visibility: entry.visibility,
			files: manifest.files.length,
			bytes: manifest.totalBytes,
			outcome: 'failed',
			detail: [],
		}

		if (entry.skipReason !== undefined) {
			record.outcome = 'skipped'
			record.detail.push(entry.skipReason)
			results.push(record)
			continue
		}
		if (entry.blockers.length > 0) {
			record.outcome = 'failed'
			record.detail.push(...entry.blockers)
			results.push(record)
			continue
		}

		try {
			let repoState
			if (!dryRun && entry.repository !== undefined && (verify || createRepos)) {
				repoState = await describeRepository({ apiBase: config.github.apiBase, token, repository: entry.repository })
				if (!repoState.exists) {
					if (!createRepos) {
						throw new Error(`仓库 ${entry.repository} 不存在，而且 createRepos=false。先在 GitHub 上建好它，或允许插件建。`)
					}
					const created = await createRepository({
						apiBase: config.github.apiBase,
						token,
						owner: config.github.owner,
						accountType: config.github.accountType,
						name: plugin.repo,
						visibility: entry.visibility,
						description: plugin.description,
					})
					record.detail.push(created.created ? `已新建仓库 ${entry.repository}（${entry.visibility}）` : `仓库 ${entry.repository} 已存在`)
					record.outcome = 'created+pushed'
					repoState = { exists: true }
				}
			}

			const published = await publish({
				manifest,
				repository: entry.repository ?? 'dry-run/local',
				branch: config.git.branch,
				commitMessage: commitMessage(config.git.commitMessageTemplate, plugin),
				git: config.git.executable,
				userName: config.git.userName,
				userEmail: config.git.userEmail,
				token,
				tokenFile: USER_CONFIG,
				dryRun,
			})
			record.sha = published.sha
			record.files = published.files
			if (dryRun) {
				record.outcome = 'planned'
				record.detail.push(`已试运行：新建 ${published.files} 个文件、一次提交 ${published.sha.slice(0, 10)}，没有推送`)
			} else {
				if (record.outcome !== 'created+pushed') record.outcome = 'pushed'
				record.detail.push(`已推送到 https://github.com/${entry.repository}（分支 ${config.git.branch}，提交 ${published.sha.slice(0, 10)}）`)

				// Topics are applied after the code so a topics failure can never cost
				// the upload. The repository exists by now, so the dedicated endpoint
				// works for both fresh and pre-existing repositories.
				const topics = Array.isArray(entry.topics) ? entry.topics : config.github.topics
				if (topics.length > 0 && entry.repository !== undefined) {
					try {
						const applied = await setTopics({
							apiBase: config.github.apiBase,
							token,
							repository: entry.repository,
							topics,
						})
						record.topics = applied.topics
						if (applied.applied) record.detail.push(`已打 topics：${applied.topics.join('、')}（见 https://github.com/topics/${applied.topics[0]}）`)
					} catch (error) {
						record.detail.push(`代码已推送，但设置 topics 失败（不影响代码）：${error.message}`)
					}
				}
			}
		} catch (error) {
			record.outcome = 'failed'
			record.detail.push(String(error.message ?? error))
		}
		results.push(record)
	}

	return { results, warnings, identity }
}

/**
 * Rewrite the diagnostics file the plugin keeps beside itself.
 *
 * @param {object} value - the diagnostics payload.
 * @returns {string} the file written.
 */
export function writeStatus(value) {
	try {
		writeFileSync(STATUS_FILE, `${JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
	} catch {
		// Diagnostics are a convenience; never fail a sync over them.
	}
	return STATUS_FILE
}

export default plan