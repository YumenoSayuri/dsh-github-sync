/**
 * Configuration and credential storage.
 *
 * Two files, deliberately separated:
 *
 *  - `sync.config.json` — this plugin's own bundle-local configuration. It lives
 *    inside the plugin directory, travels with the plugin, and is safe to share.
 *  - `%USERPROFILE%\.dsh\github-sync\config.json` — the user file. This is where
 *    the GitHub token belongs: it is outside every repository, so it can never
 *    be pushed, and it is shared by every session and every profile on the
 *    machine. Writing the token once is enough forever.
 *
 * Reading is mtime-cached so editing either file takes effect on the next tool
 * call without restarting the harness, while a hot loop of tool calls does not
 * re-stat the disk every time.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin package root (`.../dsh-github-sync`). */
export const HERE = dirname(dirname(fileURLToPath(import.meta.url)))

/** Bundle-local configuration, versioned with the plugin. */
export const BUNDLE_CONFIG = join(HERE, 'sync.config.json')
/** Diagnostics the plugin rewrites on every activation and push. */
export const STATUS_FILE = join(HERE, 'sync.status.json')

/**
 * The harness's own home directory (`~/.dsh`).
 *
 * Exported because it is a hard safety boundary, not just a location: it holds
 * this plugin's token, every session transcript, and the publish mirrors. A
 * publish target that contains it — or sits inside it — must be refused, or a
 * mistyped path would upload a credential.
 */
export const DSH_HOME = join(homedir(), '.dsh')

/** Home-level directory holding the secret-bearing user file. */
export const USER_DIR = join(DSH_HOME, 'github-sync')
/** The one file a human edits to hand the plugin a token. */
export const USER_CONFIG = join(USER_DIR, 'config.json')
/** One persistent clone per plugin: where the published commit history lives. */
export const MIRRORS_DIR = join(USER_DIR, 'mirrors')
/** Cached license bodies, so publishing never depends on the licenses endpoint twice. */
export const LICENSES_DIR = join(USER_DIR, 'licenses')

/** Accepted severities for the dsh- folder convention. */
export const NAMING_SEVERITIES = ['block', 'warn', 'off']

/**
 * Normalize the naming severity.
 *
 * The convention is about DSH plugins, and breaking it is cosmetic rather than
 * destructive — the repository simply reads as an outsider — so the default is a
 * warning. `block` is there for someone who wants the hard guarantee that no
 * misnamed repository is ever published.
 *
 * @param {unknown} value - configured `naming`.
 * @returns {'block' | 'warn' | 'off'} the effective severity.
 */
function namingOf(value) {
	if (value === undefined || value === null || value === '') return 'warn'
	const text = String(value).trim().toLowerCase()
	if (!NAMING_SEVERITIES.includes(text)) {
		throw new Error(`配置字段 naming 只能是 ${NAMING_SEVERITIES.join(' / ')}，收到的是 ${JSON.stringify(value)}`)
	}
	return text
}

/**
 * Default ceiling for one published file, in bytes.
 *
 * This is GitHub's own hard limit — "GitHub blocks files larger than 100 MiB" —
 * not an invented number. Sitting at the platform's limit means the plugin never
 * refuses something GitHub would have accepted; it only turns GitHub's opaque
 * rejection into a clear message beforehand.
 */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024

/**
 * Where GitHub starts warning, in bytes: "If you attempt to add or update a file
 * that is larger than 50 MiB, you will receive a warning from Git." A publish in
 * this band still succeeds, so the plugin warns rather than refuses.
 */
export const WARN_FILE_BYTES = 50 * 1024 * 1024

/**
 * Normalize the per-file size ceiling.
 *
 * A limit exists so an accidental multi-gigabyte artifact cannot be pushed, but
 * exceeding it is a refusal to act, not a quiet omission: a plugin whose asset
 * is dropped would be published broken, and the human would never know.
 *
 * @param {unknown} value - configured `maxFileBytes`.
 * @returns {number} the effective ceiling in bytes.
 */
function maxFileBytesOf(value) {
	if (value === undefined || value === null || value === '') return DEFAULT_MAX_FILE_BYTES
	const bytes = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
	if (!Number.isFinite(bytes) || bytes <= 0) {
		throw new Error('配置字段 maxFileBytes 必须是正整数字节数（例如 8388608 表示 8 MiB）')
	}
	return Math.floor(bytes)
}

/**
 * Accepted repository visibilities, GitHub's own vocabulary.
 */
export const VISIBILITIES = ['private', 'public']

/**
 * Directories and files that are never part of a plugin's clean copy. They are
 * build output, runtime state, dependency trees, or version-control metadata.
 *
 * Directory entries end with `/`; everything else matches a path segment
 * (a directory or a file of that exact name).
 */
export const NOISE_SEGMENTS = [
	'.git/',
	'node_modules/',
	'.venv/',
	'venv/',
	'__pycache__/',
	'.pytest_cache/',
	'.mypy_cache/',
	'.ruff_cache/',
	'.turbo/',
	'.cache/',
	'cache/',
	'.parcel-cache/',
	'dist/',
	'build/',
	'coverage/',
	'.nyc_output/',
	'.idea/',
	'.vscode/',
	'.DS_Store',
	'Thumbs.db',
	'desktop.ini',
	'*.log',
	'*.tmp',
	'.dsh-meow/',
	'_scratch/',
	'_research/',
]

/** Built-in glob patterns for runtime state a plugin writes next to itself. */
export const NOISE_PATTERNS = ['*.status.json', '*.local.json', '*.secret.json', '*.draft.json', '.env', '.env.*']

/** Keys that are duplicated here for compatibility with hand-written user files. */
const TOP_LEVEL_KEYS = new Set([
	'version',
	'dataDir',
	'configFiles',
	'workspaceRoot',
	'pluginDirs',
	'mirrorsDir',
	'licensesDir',
	'maxFileBytes',
	'naming',
	'github',
	'git',
	'excludeNames',
	'excludePatterns',
	'plugins',
	'_comment',
])

/** @type {{ config: MultiConfig, stamp: string } | undefined} */
let cache

/** Marker string a user file carries so the plugin never mistakes it for a stray file. */
const USER_FILE_MARKER = 'dsh-github-sync'

/**
 * Read one JSON file, tolerating absence and reporting malformed content by its
 * path rather than throwing an opaque parse error.
 *
 * @param {string} path - absolute file path.
 * @returns {Record<string, unknown> | undefined} parsed object, or undefined.
 */
function readJson(path) {
	if (!existsSync(path)) return undefined
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		throw new Error(`读取配置失败：${path}（${error.message}）`)
	}
	// Tolerate a UTF-8 BOM and an empty file, both of which Windows editors produce.
	const cleaned = text.replace(/^\uFEFF/, '').trim()
	if (cleaned === '') return {}
	try {
		const value = JSON.parse(cleaned)
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('顶层必须是一个 JSON 对象')
		}
		return value
	} catch (error) {
		throw new Error(`解析配置失败：${path}\n${error.message}\n（提示：JSON 不允许尾随逗号，也不允许 // 注释）`)
	}
}

/**
 * Strip `_comment*` keys, which exist only as inline documentation.
 *
 * @param {Record<string, unknown>} value - raw configuration object.
 * @returns {Record<string, unknown>} the same object without comment keys.
 */
function withoutComments(value) {
	const out = {}
	for (const [key, item] of Object.entries(value)) {
		if (key.startsWith('_comment')) continue
		out[key] = item
	}
	return out
}

/**
 * Merge one configuration layer over another. Objects merge key by key; arrays
 * and scalars replace outright, so a user file can shorten an exclude list
 * instead of only appending to it.
 *
 * One deliberate exception: an **empty string** in the higher layer does not
 * erase a non-empty value in the lower layer. A generated user file ships
 * `"owner": ""` / `"token": ""` as obvious places to type, and those blanks must
 * not silently wipe an owner or token that the bundle file already sets. Use
 * `null` to clear a value on purpose.
 *
 * @param {Record<string, unknown>} base - lower-priority layer.
 * @param {Record<string, unknown>} over - higher-priority layer.
 * @returns {Record<string, unknown>} merged configuration.
 */
function mergeConfig(base, over) {
	const out = { ...base }
	for (const [key, value] of Object.entries(over)) {
		const previous = out[key]
		if (
			typeof value === 'string' &&
			value.trim() === '' &&
			typeof previous === 'string' &&
			previous.trim() !== ''
		) {
			// A blank placeholder never erases a configured value.
			continue
		}
		if (
			value !== null &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			previous !== null &&
			typeof previous === 'object' &&
			!Array.isArray(previous)
		) {
			out[key] = mergeConfig(previous, value)
		} else {
			out[key] = value
		}
	}
	return out
}

/**
 * First mtime/size pair over several files, used as the cache key.
 *
 * @param {string[]} paths - files to fingerprint.
 * @returns {string} a cache stamp that changes when any file changes.
 */
function stampOf(paths) {
	return paths
		.map((path) => {
			try {
				const stat = statSync(path)
				return `${path}:${stat.mtimeMs}:${stat.size}`
			} catch {
				return `${path}:missing`
			}
		})
		.join('|')
}

/**
 * Normalize a GitHub API base URL.
 *
 * @param {unknown} value - configured base URL.
 * @returns {string} a base URL with no trailing slash.
 */
function apiBaseOf(value) {
	const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'https://api.github.com'
	return text.replace(/\/+$/, '')
}

/**
 * Normalize a list of strings.
 *
 * @param {unknown} value - configured value.
 * @param {string} label - field name used in error text.
 * @returns {string[]} trimmed, non-empty entries.
 */
function stringList(value, label) {
	if (value === undefined || value === null) return []
	if (!Array.isArray(value)) throw new Error(`配置字段 ${label} 必须是字符串数组`)
	return value.map((item) => String(item).trim()).filter((item) => item !== '')
}

/**
 * Normalize one plugin entry from the `plugins` map.
 *
 * @param {string} key - the map key, which is the directory name by default.
 * @param {unknown} value - the entry's raw value.
 * @returns {Record<string, unknown>} the normalized entry.
 */
function pluginEntry(key, value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`配置字段 plugins.${key} 必须是一个对象`)
	}
	const raw = withoutComments(value)
	const entry = { ...raw }
	if (entry.dir !== undefined) entry.dir = String(entry.dir)
	if (entry.repo !== undefined) entry.repo = String(entry.repo)
	if (entry.owner !== undefined) entry.owner = String(entry.owner)
	if (entry.description !== undefined) entry.description = String(entry.description)
	if (entry.visibility !== undefined) {
		const visibility = String(entry.visibility)
		if (!VISIBILITIES.includes(visibility)) {
			throw new Error(`配置字段 plugins.${key}.visibility 只能是 ${VISIBILITIES.join(' 或 ')}`)
		}
		entry.visibility = visibility
	}
	if (entry.include !== undefined) entry.include = stringList(entry.include, `plugins.${key}.include`)
	if (entry.exclude !== undefined) entry.exclude = stringList(entry.exclude, `plugins.${key}.exclude`)
	if (entry.topics !== undefined) entry.topics = topicList(entry.topics)
	if (entry.license !== undefined) {
		entry.license = entry.license === null ? null : String(entry.license).trim()
	}
	if (entry.excludeNames !== undefined) entry.excludeNames = stringList(entry.excludeNames, `plugins.${key}.excludeNames`)
	if (entry.excludePatterns !== undefined) {
		entry.excludePatterns = stringList(entry.excludePatterns, `plugins.${key}.excludePatterns`)
	}
	if (entry.enabled !== undefined) entry.enabled = entry.enabled !== false
	if (entry.allowEmpty !== undefined) entry.allowEmpty = entry.allowEmpty === true
	return entry
}

/**
 * Load and merge bundle + user configuration.
 *
 * The user file wins over the bundle file. Beyond the plugin's own schema, the
 * `{ version, dataDir, configFiles }` shape is also accepted, because a
 * directory-owning deployment hands plugins exactly that and a hand-written
 * service file should not have to care which form it is.
 *
 * @returns {ResolvedConfig} validated configuration plus the files it came from.
 */
export function loadConfig() {
	const stamp = stampOf([BUNDLE_CONFIG, USER_CONFIG])
	if (cache !== undefined && cache.stamp === stamp) return cache.config

	const bundleRaw = withoutComments(readJson(BUNDLE_CONFIG) ?? {})
	const userRaw = withoutComments(readJson(USER_CONFIG) ?? {})

	// A user file that holds the whole plugin schema directly is treated as the
	// top layer; one nested under `github-sync` is unwrapped first.
	const nested = userRaw[USER_FILE_MARKER]
	const userLayer = { ...userRaw }
	if (nested !== undefined && nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
		delete userLayer[USER_FILE_MARKER]
		Object.assign(userLayer, withoutComments(nested))
	}
	const unknownUser = Object.keys(userLayer).filter(
		(key) => !TOP_LEVEL_KEYS.has(key) && !key.startsWith('_comment'),
	)

	const merged = mergeConfig(bundleRaw, userLayer)

	const githubRaw = withoutComments(merged.github && typeof merged.github === 'object' ? merged.github : {})
	const gitRaw = withoutComments(merged.git && typeof merged.git === 'object' ? merged.git : {})
	const pluginsRaw = merged.plugins && typeof merged.plugins === 'object' && !Array.isArray(merged.plugins) ? merged.plugins : {}
	const bundleGithub = withoutComments(bundleRaw.github && typeof bundleRaw.github === 'object' ? bundleRaw.github : {})
	const userGithub = withoutComments(userLayer.github && typeof userLayer.github === 'object' ? userLayer.github : {})

	/** @type {Record<string, Record<string, unknown>>} */
	const plugins = {}
	for (const [key, value] of Object.entries(pluginsRaw)) plugins[key] = pluginEntry(key, value)

	const warnings = []

	/**
	 * Accepted token shapes, by prefix. Used both to recognize a real token and
	 * to refuse publishing any file that carries one.
	 *
	 * @param {string} value - candidate text.
	 * @returns {boolean} true when it looks like a GitHub credential.
	 */
	const looksLikeToken = (value) => /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(value)

	/**
	 * One layer's credential candidates.
	 *
	 * `tokenEnv` is documented as an environment-variable *name*. Someone will
	 * paste the token into it anyway, so that mistake is detected and used rather
	 * than silently ignored.
	 *
	 * @param {Record<string, unknown>} block - a `github` config block.
	 * @returns {{ direct?: string, viaEnvName?: string, envName?: string }} candidates.
	 */
	function tokenCandidate(block) {
		const direct = typeof block.token === 'string' && block.token.trim() !== '' ? block.token.trim() : undefined
		const envValue = typeof block.tokenEnv === 'string' && block.tokenEnv.trim() !== '' ? block.tokenEnv.trim() : undefined
		if (envValue !== undefined && looksLikeToken(envValue)) return { direct, viaEnvName: envValue }
		return { direct, envName: envValue }
	}

	const userCandidate = tokenCandidate(userGithub)
	const bundleCandidate = tokenCandidate(bundleGithub)
	const envName =
		userCandidate.envName ?? bundleCandidate.envName ?? (typeof githubRaw.tokenEnv === 'string' && githubRaw.tokenEnv.trim() !== '' ? githubRaw.tokenEnv.trim() : 'GITHUB_TOKEN')
	const envToken = process.env[envName] ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN

	/** @type {{ token?: string, source?: string, origin?: 'user' | 'bundle' | 'env' }} */
	let credential = {}
	if (userCandidate.direct !== undefined) credential = { token: userCandidate.direct, source: `user-config:${USER_CONFIG}`, origin: 'user' }
	else if (userCandidate.viaEnvName !== undefined) credential = { token: userCandidate.viaEnvName, source: `user-config:${USER_CONFIG}（写在了 github.tokenEnv，该字段本意是环境变量名）`, origin: 'user' }
	else if (bundleCandidate.direct !== undefined) credential = { token: bundleCandidate.direct, source: `bundle-config:${BUNDLE_CONFIG}`, origin: 'bundle' }
	else if (bundleCandidate.viaEnvName !== undefined) credential = { token: bundleCandidate.viaEnvName, source: `bundle-config:${BUNDLE_CONFIG}（写在了 github.tokenEnv，该字段本意是环境变量名）`, origin: 'bundle' }
	else if (typeof envToken === 'string' && envToken.trim() !== '') credential = { token: envToken.trim(), source: `env:${envName}`, origin: 'env' }

	if (userCandidate.viaEnvName !== undefined || bundleCandidate.viaEnvName !== undefined) {
		warnings.push(
			'`github.tokenEnv` 里填的看起来是 token 本身，但这个字段的本意是「环境变量名」。已按 token 使用；建议把值改到 `github.token`，并把 tokenEnv 恢复成变量名（如 GITHUB_TOKEN）。',
		)
	}
	if (credential.origin === 'bundle' || bundleCandidate.direct !== undefined) {
		warnings.push(
			`token 写在插件目录里的 ${BUNDLE_CONFIG}。那个文件本身在插件的干净副本范围内，等于把密钥放在要上传的目录里。` +
				`内存扫描会在推送时排除含密钥的文件，但正确做法是把 token 挪到 ${USER_CONFIG} 的 github.token。`,
		)
	}

	const visibility = githubRaw.defaultVisibility === 'public' ? 'public' : 'private'

	return {
		stamp,
		files: {
			bundle: existsSync(BUNDLE_CONFIG) ? BUNDLE_CONFIG : undefined,
			user: existsSync(USER_CONFIG) ? USER_CONFIG : undefined,
		},
		workspaceRoot: typeof merged.workspaceRoot === 'string' && merged.workspaceRoot.trim() !== '' ? merged.workspaceRoot.trim() : undefined,
		pluginDirs: stringList(merged.pluginDirs, 'pluginDirs'),
		maxFileBytes: maxFileBytesOf(merged.maxFileBytes),
		naming: namingOf(merged.naming),
		mirrorsDir:
			typeof merged.mirrorsDir === 'string' && merged.mirrorsDir.trim() !== '' ? merged.mirrorsDir.trim() : MIRRORS_DIR,
		licensesDir:
			typeof merged.licensesDir === 'string' && merged.licensesDir.trim() !== '' ? merged.licensesDir.trim() : LICENSES_DIR,
		github: {
			owner: typeof githubRaw.owner === 'string' ? githubRaw.owner.trim() : '',
			accountType: githubRaw.accountType === 'org' ? 'org' : 'user',
			apiBase: apiBaseOf(githubRaw.apiBase),
			verify: githubRaw.verify !== false,
			token: credential.token,
			tokenSource: credential.source,
			tokenOrigin: credential.origin,
			topics: topicList(githubRaw.topics),
			// null means "do not generate one"; the status report then nags instead.
			license:
				githubRaw.license === null || githubRaw.license === ''
					? null
					: typeof githubRaw.license === 'string' && githubRaw.license.trim() !== ''
						? githubRaw.license.trim()
						: null,
			// Who the generated copyright line names. Defaults to the account owner.
			copyright:
				typeof githubRaw.copyright === 'string' && githubRaw.copyright.trim() !== ''
					? githubRaw.copyright.trim()
					: typeof githubRaw.owner === 'string'
						? githubRaw.owner.trim()
						: '',
		},
		git: {
			executable: typeof gitRaw.executable === 'string' && gitRaw.executable.trim() !== '' ? gitRaw.executable.trim() : 'git',
			// Left undefined on purpose: the committer identity is derived from the
			// authenticated GitHub account (name + its noreply address) so commits are
			// attributed to the human who wrote them. Inventing a bot identity here
			// would make every commit show up as an unlinked stranger on GitHub.
			userName: typeof gitRaw.userName === 'string' && gitRaw.userName.trim() !== '' ? gitRaw.userName.trim() : undefined,
			userEmail: typeof gitRaw.userEmail === 'string' && gitRaw.userEmail.trim() !== '' ? gitRaw.userEmail.trim() : undefined,
			branch: typeof gitRaw.branch === 'string' && gitRaw.branch.trim() !== '' ? gitRaw.branch.trim() : 'main',
			commitMessageTemplate:
				typeof gitRaw.commitMessageTemplate === 'string' && gitRaw.commitMessageTemplate.trim() !== ''
					? gitRaw.commitMessageTemplate
					: 'sync {name} {version} ({stamp})',
		},
		visibility,
		excludeNames: stringList(merged.excludeNames, 'excludeNames'),
		excludePatterns: stringList(merged.excludePatterns, 'excludePatterns'),
		plugins,
		unknownUserKeys: unknownUser,
		warnings,
	}
}

/** Default topic every published plugin gets, so the community can find it. */
export const DEFAULT_TOPICS = ['dsh-plugin']

/**
 * Normalize a topic list to GitHub's own rules: lowercase, hyphens instead of
 * spaces, only `[a-z0-9-]`, at most 50 characters each, at most 20 topics.
 *
 * @param {unknown} value - configured value; omitted means the default topic.
 * @returns {string[]} the topics to apply, `[]` when explicitly disabled.
 */
function topicList(value) {
	if (value === undefined) return [...DEFAULT_TOPICS]
	if (value === null) return []
	if (!Array.isArray(value)) throw new Error('配置字段 github.topics 必须是字符串数组（也可以写空数组 [] 表示不打标签）')
	const seen = new Set()
	for (const item of value) {
		const normalized = String(item)
			.trim()
			.toLowerCase()
			.replace(/[\s_]+/g, '-')
			.replace(/[^a-z0-9-]/g, '')
			.replace(/-{2,}/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 50)
		if (normalized !== '') seen.add(normalized)
	}
	return [...seen].slice(0, 20)
}

/**
 * Write the user credential file with the given token, creating the directory.
 *
 * The file is written as plain JSON. On Windows the per-user profile directory
 * is already restricted to the signed-in account; FileVault or LUKS provides the
 * equivalent elsewhere. The token never enters a repository either way.
 *
 * @param {string} token - the GitHub token to persist.
 * @returns {string} the file it was written to.
 */
export function writeUserToken(token) {
	const value = String(token ?? '').trim()
	if (value === '') throw new Error('token 不能为空')
	mkdirSync(USER_DIR, { recursive: true })
	const existing = withoutComments(readJson(USER_CONFIG) ?? {})
	const github = existing.github && typeof existing.github === 'object' && !Array.isArray(existing.github) ? { ...existing.github } : {}
	github.token = value
	const next = { ...existing, github }
	writeFileSync(USER_CONFIG, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
	cache = undefined
	return USER_CONFIG
}

/**
 * Remove the persisted token from the user file.
 *
 * @returns {boolean} true when a token was present and is now gone.
 */
export function clearUserToken() {
	const existing = withoutComments(readJson(USER_CONFIG) ?? {})
	const github = existing.github && typeof existing.github === 'object' && !Array.isArray(existing.github) ? { ...existing.github } : undefined
	if (github === undefined || github.token === undefined) {
		cache = undefined
		return false
	}
	delete github.token
	const next = { ...existing, github }
	writeFileSync(USER_CONFIG, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
	cache = undefined
	return true
}

/**
 * Create the user file with a documented skeleton when it does not exist, so a
 * human has an obvious place to paste a credential.
 *
 * The blank `owner`/`token` values are intentional affordances: the merge rule
 * above never lets a blank placeholder erase a value from the bundle file.
 *
 * @returns {string} the user file path.
 */
export function ensureUserConfig() {
	if (existsSync(USER_CONFIG)) return USER_CONFIG
	mkdirSync(USER_DIR, { recursive: true })
	const skeleton = {
		_comment_1: '这个文件不在任何仓库里，token 只写一次，所有 DSH 会话与 profile 共用。',
		_comment_2: 'github.owner 填你的 GitHub 用户名（插件目录里的 sync.config.json 里如果已经填了，这里可以留空）。',
		_comment_3: 'github.token 填 token 本身（ghp_… 或 github_pat_…）。不要把 token 写到插件目录里。',
		_comment_4: 'github.topics 是给新仓库打的 GitHub topic，「联合投稿」用；默认就是 dsh-plugin，不想打标签就写 []。',
		_comment_5: 'github.license：插件里没有 LICENSE 时自动生成哪个协议（MIT / Apache-2.0 / BSD-3-Clause / MPL-2.0 / GPL-3.0 / Unlicense…）。留空表示不生成，只在状态里提醒你——选协议是法律决定，工具不替你定。',
		_comment_6: 'github.copyright：自动生成的版权行署名；留空则用 github.owner。',
		_comment_7: 'git.userEmail / git.userName 是**提交署名**。两者都留空，就用 token 所属账号派生：名字取账号显示名，邮箱用 <你的ID>+<用户名>@users.noreply.github.com —— 能关联到你的头像，又不公开真实邮箱。',
		_comment_8: '想署自己的邮箱就填 git.userEmail，但该邮箱必须**先在 GitHub 账号里验证过**；否则提交在 GitHub 上会显示成一个无头像、点不开的陌生人。另外注意：写进提交的邮箱是公开的。',
		_comment_9: 'naming：dsh- 前缀约定的严重度。warn（默认）只警告、仍可发布；block 硬拦；off 不检查。这条约定只对【DSH 插件】生效（依据 package.json 的 dsh.bundle / dsh.client，或关键词含 dsh）。',
		naming: '',
		github: {
			owner: '',
			token: '',
			topics: ['dsh-plugin'],
			license: '',
			copyright: '',
		},
		git: {
			userName: '',
			userEmail: '',
		},
	}
	writeFileSync(USER_CONFIG, `${JSON.stringify(skeleton, null, 2)}\n`, 'utf8')
	return USER_CONFIG
}

