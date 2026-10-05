/**
 * Clean-copy manifest.
 *
 * Decides exactly which bytes of a plugin directory belong in its repository.
 * The default posture is `gitignore` mode: walk everything, then drop the
 * well-known noise (dependency trees, build output, caches, runtime state files
 * such as `*.status.json`, secrets such as `.env`) plus whatever the plugin's own
 * `.gitignore` files say — including `!` re-includes, so a plugin that tracks a
 * build artifact keeps it.
 *
 * `allowlist` mode is the other posture and answers "exclude everything that is
 * not strictly required": only the `include` prefixes ship. It is what a plugin
 * wants when almost all of its directory is local scaffolding.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { NOISE_PATTERNS, NOISE_SEGMENTS } from './config.js'

/** Upper bound for a single shipped file; anything larger is reported, not copied. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

/**
 * Translate one glob into a regular expression. Supported syntax is the subset
 * `.gitignore` and the plugin's own config use: `*`, `?`, `**`, and `[...]`.
 *
 * @param {string} glob - the pattern to translate.
 * @returns {RegExp} an anchored expression for a `/`-separated path.
 */
function globToRegExp(glob) {
	let out = ''
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i]
		if (char === '*') {
			if (glob[i + 1] === '*') {
				// `**/` spans zero or more path segments; a trailing `**` spans the rest.
				i++
				if (glob[i + 1] === '/') {
					i++
					out += '(?:[^/]+/)*'
				} else {
					out += '.*'
				}
			} else {
				out += '[^/]*'
			}
			continue
		}
		if (char === '?') {
			out += '[^/]'
			continue
		}
		if (char === '[') {
			const close = glob.indexOf(']', i + 1)
			if (close === -1) {
				out += '\\['
				continue
			}
			const body = glob.slice(i + 1, close)
			out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
			i = close
			continue
		}
		out += char.replace(/[.+^${}()|\\]/g, '\\$&')
	}
	return new RegExp(`^${out}$`)
}

/**
 * Test one path against one pattern, honoring the pattern's leading slash and
 * any embedded slashes.
 *
 * @param {string} path - `/`-separated path relative to the plugin root.
 * @param {string} name - the path's final segment.
 * @param {string} pattern - one pattern.
 * @returns {boolean} true when the path matches.
 */
function matches(path, name, pattern) {
	let glob = pattern.trim()
	if (glob === '') return false
	if (glob.endsWith('/')) glob = glob.slice(0, -1)
	const anchored = glob.startsWith('/')
	if (anchored) glob = glob.slice(1)
	const hasSlash = glob.includes('/')
	const expression = globToRegExp(glob)
	if (anchored || hasSlash) return expression.test(path)
	// An unanchored single-segment pattern matches that segment anywhere.
	return expression.test(name) || globToRegExp(`(?:[^/]+/)*${glob}`).test(path)
}

/**
 * Match a path against a list of patterns; the last matching pattern wins so a
 * later `!` can re-include what an earlier line excluded.
 *
 * @param {string} path - `/`-separated path relative to the plugin root.
 * @param {string} name - the path's final segment.
 * @param {string[]} patterns - patterns in file order.
 * @returns {boolean} true when the path ends up excluded.
 */
function excludedBy(path, name, patterns) {
	let excluded = false
	for (const pattern of patterns) {
		const negated = pattern.startsWith('!')
		const body = negated ? pattern.slice(1) : pattern
		if (!matches(path, name, body)) continue
		excluded = !negated
	}
	return excluded
}

/**
 * Parse `.gitignore` text into ordered patterns, dropping blanks and comments.
 *
 * @param {string} text - file contents.
 * @returns {string[]} patterns, with `!` prefixes preserved.
 */
function parseIgnoreFile(text) {
	const patterns = []
	for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = rawLine.trim()
		if (line === '' || line.startsWith('#')) continue
		patterns.push(line)
	}
	return patterns
}

/**
 * Normalize one include prefix: drop a leading `./` and trailing slashes.
 *
 * @param {unknown} raw - one configured include entry.
 * @returns {string} the normalized prefix.
 */
function includePrefix(raw) {
	return String(raw)
		.replace(/^\.\//, '')
		.replace(/\/+$/, '')
}

/**
 * Whether an include prefix can still reach into a directory.
 *
 * @param {string} prefix - normalized include prefix.
 * @param {string} dirPath - `/`-separated directory path.
 * @returns {boolean} true when the directory must be descended into.
 */
function prefixCouldContain(prefix, dirPath) {
	if (prefix === '') return true
	if (prefix.includes('*') || prefix.includes('?')) return true
	return prefix === dirPath || prefix.startsWith(`${dirPath}/`) || dirPath.startsWith(`${prefix}/`)
}

/**
 * Whether one file is named by an include list.
 *
 * @param {string[]} include - normalized include prefixes.
 * @param {string} path - `/`-separated file path.
 * @param {string} name - the file's final segment.
 * @returns {boolean} true when the file ships.
 */
function listedBy(include, path, name) {
	return include.some((prefix) => {
		if (prefix === '') return false
		if (prefix.includes('*') || prefix.includes('?')) return matches(path, name, prefix)
		return path === prefix || path.startsWith(`${prefix}/`)
	})
}

/**
 * Build the clean-copy manifest for one plugin directory.
 *
 * @param {object} options - manifest inputs.
 * @param {string} options.dir - absolute plugin directory.
 * @param {Record<string, unknown>} [options.entry] - the plugin's configured entry.
 * @param {string[]} [options.excludeNames] - extra segment names to drop.
 * @param {string[]} [options.excludePatterns] - extra glob patterns to drop.
 * @returns {Manifest} included files, excluded paths with reasons, and notes.
 */
export function buildManifest({ dir, entry = {}, excludeNames = [], excludePatterns = [] }) {
	const include = Array.isArray(entry.include) ? entry.include.map(includePrefix) : undefined
	const policies = Array.isArray(entry.policies) ? entry.policies.map(String) : []
	const useGitignore = policies.length === 0 || policies.includes('gitignore')
	const useDefaults = policies.length === 0 || policies.includes('defaults')
	const extraNames = [...NOISE_SEGMENTS, ...excludeNames, ...(Array.isArray(entry.excludeNames) ? entry.excludeNames : [])]
	const extraPatterns = [...NOISE_PATTERNS, ...excludePatterns, ...(Array.isArray(entry.excludePatterns) ? entry.excludePatterns : [])]

	/** @type {{ path: string, bytes: number, mtimeMs: number }[]} */
	const files = []
	/** @type {{ path: string, reason: string }[]} */
	const excluded = []
	/** @type {{ path: string, kind: string }[]} */
	const secrets = []
	const notes = []
	let skippedSymlinks = 0
	let oversized = 0

	/**
	 * Whether a segment is dropped by the built-in noise list or an extra rule.
	 *
	 * @param {string} name - the segment name.
	 * @param {string} path - the `/`-separated relative path.
	 * @returns {string | undefined} the reason, when dropped.
	 */
	function noiseReason(name, path) {
		for (const candidate of extraNames) {
			const isDirRule = candidate.endsWith('/')
			const value = isDirRule ? candidate.slice(0, -1) : candidate
			if (value.includes('*') || value.includes('?')) {
				if (matches(path, name, value)) return `内置排除：${value}`
				continue
			}
			if (name === value) return `内置排除：${value}${isDirRule ? '/' : ''}`
		}
		if (excludedBy(path, name, extraPatterns)) return '内置排除：运行期状态 / 密钥文件'
		return undefined
	}

	/**
	 * Visit one directory.
	 *
	 * @param {string} absolute - absolute directory path.
	 * @param {string} rel - `/`-separated path relative to the plugin root; `''` at the root.
	 * @param {string[]} inherited - gitignore patterns from ancestors.
	 */
	function walk(absolute, rel, inherited) {
		let patterns = inherited
		let children
		try {
			children = readdirSync(absolute, { withFileTypes: true })
		} catch (error) {
			notes.push(`读取目录失败：${rel || '.'}（${error.message}）`)
			return
		}

		if (useGitignore && children.some((child) => child.isFile() && child.name === '.gitignore')) {
			try {
				patterns = [...inherited, ...parseIgnoreFile(readFileSync(join(absolute, '.gitignore'), 'utf8'))]
			} catch (error) {
				notes.push(`读取 .gitignore 失败：${rel || '.'}（${error.message}）`)
			}
		}

		for (const child of children) {
			const childRel = rel === '' ? child.name : `${rel}/${child.name}`
			const childAbs = join(absolute, child.name)

			if (include !== undefined && !prefixCouldContainAny(include, childRel)) {
				excluded.push({ path: child.isDirectory() ? `${childRel}/` : childRel, reason: '不在 include 白名单' })
				continue
			}

			if (child.isSymbolicLink()) {
				skippedSymlinks++
				excluded.push({ path: childRel, reason: '符号链接（不跟随，避免把仓库外的内容复制出去）' })
				continue
			}

			if (child.isDirectory()) {
				if (include === undefined) {
					const reason = noiseReason(child.name, childRel)
					if (reason !== undefined) {
						excluded.push({ path: `${childRel}/`, reason })
						continue
					}
					if (useGitignore && excludedBy(childRel, child.name, patterns)) {
						excluded.push({ path: `${childRel}/`, reason: '.gitignore' })
						continue
					}
				}
				walk(childAbs, childRel, patterns)
				continue
			}

			if (!child.isFile()) continue

			if (include !== undefined) {
				if (!listedBy(include, childRel, child.name)) {
					excluded.push({ path: childRel, reason: '不在 include 白名单' })
					continue
				}
			} else {
				if (useDefaults) {
					const reason = noiseReason(child.name, childRel)
					if (reason !== undefined) {
						excluded.push({ path: childRel, reason })
						continue
					}
				}
				if (useGitignore && excludedBy(childRel, child.name, patterns)) {
					excluded.push({ path: childRel, reason: '.gitignore' })
					continue
				}
			}

			let info
			try {
				info = statSync(childAbs)
			} catch (error) {
				notes.push(`stat 失败：${childRel}（${error.message}）`)
				continue
			}
			if (info.size > MAX_FILE_BYTES) {
				oversized++
				excluded.push({ path: childRel, reason: `超过单文件上限 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB` })
				continue
			}

			// Last gate before a file is allowed to ship: does it carry a
			// credential? This exists because a plugin directory is exactly where a
			// token gets pasted by mistake — into a config file that then looks like
			// an ordinary part of the package.
			const secret = secretIn(childAbs, childRel, info.size)
			if (secret !== undefined) {
				secrets.push({ path: childRel, kind: secret })
				excluded.push({ path: childRel, reason: `疑似密钥，不推送（${secret}）` })
				notes.push(
					`${childRel} 疑似包含 ${secret}。已从干净副本中排除，推送前请确认这是不是真密钥；若是，请从插件目录里删掉并轮换该密钥。`,
				)
				continue
			}

			files.push({ path: childRel, bytes: info.size, mtimeMs: info.mtimeMs })
		}
	}

	walk(dir, '', [])

	files.sort((a, b) => a.path.localeCompare(b.path))
	const excludedSorted = excluded.sort((a, b) => a.path.localeCompare(b.path))
	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)

	return {
		dir,
		mode: include !== undefined ? 'allowlist' : 'gitignore',
		include,
		policies: { defaults: useDefaults, gitignore: useGitignore },
		files,
		excluded: excludedSorted,
		secrets,
		totalBytes,
		notes,
		skippedSymlinks,
		oversized,
	}
}

/** Upper bound for a file whose text is scanned for credentials. */
export const MAX_SCAN_BYTES = 1024 * 1024

/**
 * Credential shapes worth refusing to publish. Each entry is a name shown to a
 * human plus the pattern itself. The character-count floors are deliberate: a
 * documentation example such as `ghp_xxxx` must not trip the gate, while a real
 * token — which is always longer — must.
 */
const SECRET_SHAPES = [
	['GitHub 经典 token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
	['GitHub 细粒度 token', /\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
	['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
	['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
	['OpenAI 风格密钥', /\bsk-[A-Za-z0-9_-]{32,}\b/],
	['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
	['私钥文件', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
]

/** Extensions whose contents are worth scanning; binaries are skipped outright. */
const SCANNABLE_EXTENSIONS = new Set([
	'.json',
	'.json5',
	'.jsonc',
	'.md',
	'.markdown',
	'.txt',
	'.js',
	'.mjs',
	'.cjs',
	'.jsx',
	'.ts',
	'.mts',
	'.cts',
	'.tsx',
	'.yml',
	'.yaml',
	'.toml',
	'.ini',
	'.cfg',
	'.conf',
	'.properties',
	'.env',
	'.sh',
	'.bash',
	'.zsh',
	'.ps1',
	'.psm1',
	'.bat',
	'.cmd',
	'.py',
	'.rb',
	'.go',
	'.rs',
	'.xml',
	'.html',
	'.htm',
	'.css',
	'.csv',
	'.sql',
])

/**
 * Look for a credential inside one file.
 *
 * Only text-shaped files under the scan size are read; anything else is skipped,
 * because a token lives in text and reading 20 MiB of PNG bytes to prove that is
 * a waste.
 *
 * @param {string} absolute - absolute file path.
 * @param {string} rel - `/`-separated path, used for the extension test.
 * @param {number} size - file size in bytes.
 * @returns {string | undefined} the credential kind, when one is found.
 */
function secretIn(absolute, rel, size) {
	if (size === 0 || size > MAX_SCAN_BYTES) return undefined
	const dot = rel.lastIndexOf('.')
	const extension = dot === -1 ? '' : rel.slice(dot).toLowerCase()
	const baseName = rel.slice(rel.lastIndexOf('/') + 1)
	if (!SCANNABLE_EXTENSIONS.has(extension) && !baseName.startsWith('.env')) return undefined
	let text
	try {
		text = readFileSync(absolute, 'utf8')
	} catch {
		// Unreadable or non-UTF-8 content: not text, so nothing to find.
		return undefined
	}
	for (const [kind, pattern] of SECRET_SHAPES) {
		if (pattern.test(text)) return kind
	}
	return undefined
}

/**
 * Whether any include prefix could reach into a directory.
 *
 * @param {string[]} include - normalized include prefixes.
 * @param {string} dirPath - `/`-separated directory path.
 * @returns {boolean} true when the directory must be descended into.
 */
function prefixCouldContainAny(include, dirPath) {
	return include.some((prefix) => prefixCouldContain(prefix, dirPath))
}

export default buildManifest