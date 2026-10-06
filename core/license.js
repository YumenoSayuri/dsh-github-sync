/**
 * Open-source license handling.
 *
 * The plugin's job here is narrow and deliberate: never invent legal terms. A
 * license text is taken from GitHub's own `GET /licenses/{key}`, which serves the
 * canonical SPDX text with `[year]` / `[fullname]` placeholders; the plugin only
 * substitutes the copyright line. Nothing is generated unless a license is
 * configured, and an existing license file in the plugin always wins.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File names that count as "this plugin already declares a license". */
export const LICENSE_FILE_NAMES = [
	'license',
	'license.md',
	'license.txt',
	'license.rst',
	'licence',
	'licence.md',
	'licence.txt',
	'copying',
	'copying.md',
	'copying.txt',
	'unlicense',
]

/**
 * Find the license file a manifest already ships.
 *
 * @param {Manifest} manifest - the built manifest.
 * @returns {string | undefined} the matching path, when one exists.
 */
export function licenseFileOf(manifest) {
	for (const file of manifest.files) {
		const base = file.path.slice(file.path.lastIndexOf('/') + 1).toLowerCase()
		if (LICENSE_FILE_NAMES.includes(base)) return file.path
	}
	return undefined
}

/**
 * Substitute the copyright placeholders in a license body.
 *
 * GitHub ships the canonical text with `[year]` / `[fullname]`, and Apache-2.0
 * with `[yyyy]`. A license without placeholders (MPL-2.0, Unlicense) comes back
 * untouched, which is correct: those texts do not name a copyright holder.
 *
 * @param {string} body - the license text from GitHub.
 * @param {object} options - substitution inputs.
 * @param {string} options.year - the copyright year.
 * @param {string} options.copyright - the copyright holder.
 * @returns {string} the license text to commit.
 */
export function renderLicense(body, { year, copyright }) {
	return String(body)
		.replace(/\[year\]/g, year)
		.replace(/\[yyyy\]/g, year)
		.replace(/\[fullname\]/g, copyright)
}

/**
 * Read one license body, from the local cache when possible.
 *
 * The cache exists so a publish never depends on the licenses endpoint being
 * reachable again, and so the same text is committed on every machine.
 *
 * @param {object} options - fetch inputs.
 * @param {string} options.apiBase - GitHub API base URL.
 * @param {string | undefined} options.token - token, when one is available.
 * @param {string} options.key - license key, such as `mit` or `apache-2.0`.
 * @param {string} options.cacheDir - directory holding cached license bodies.
 * @returns {Promise<{ key: string, spdxId: string, name: string, body: string, cached: boolean }>} the license.
 */
export async function fetchLicense({ apiBase, token, key, cacheDir }) {
	const normalized = String(key).trim().toLowerCase()
	const cacheFile = join(cacheDir, `${normalized}.json`)
	if (existsSync(cacheFile)) {
		try {
			const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
			if (typeof cached?.body === 'string' && cached.body !== '') {
				return { key: normalized, spdxId: cached.spdxId, name: cached.name, body: cached.body, cached: true }
			}
		} catch {
			// A corrupt cache entry is simply refetched below.
		}
	}

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 20_000)
	let response
	try {
		response = await fetch(`${apiBase}/licenses/${encodeURIComponent(normalized)}`, {
			signal: controller.signal,
			headers: {
				accept: 'application/vnd.github+json',
				'x-github-api-version': '2022-11-28',
				'user-agent': 'dsh-github-sync',
				...(typeof token === 'string' && token !== '' ? { authorization: `Bearer ${token}` } : {}),
			},
		})
	} catch (error) {
		const reason = error.name === 'AbortError' ? '超过 20 秒' : error.message
		throw new Error(
			`取不到协议文本（${normalized}）：${reason}\n` +
				'把 github.license 设为空字符串可以关闭自动生成，或稍后重试（文本会缓存到本地：' +
				cacheDir +
				'）。',
		)
	} finally {
		clearTimeout(timer)
	}

	if (response.status === 404) {
		throw new Error(
			`GitHub 不认识协议标识「${normalized}」。常用值：MIT、Apache-2.0、BSD-3-Clause、ISC、MPL-2.0、GPL-3.0、Unlicense、CC0-1.0。`,
		)
	}
	if (response.status !== 200) {
		throw new Error(`取协议文本失败：HTTP ${response.status}（${normalized}）`)
	}
	const json = await response.json()
	const body = String(json?.body ?? '')
	if (body === '') throw new Error(`协议「${normalized}」没有返回正文，无法生成 LICENSE。`)

	try {
		mkdirSync(cacheDir, { recursive: true })
		writeFileSync(cacheFile, `${JSON.stringify({ spdxId: json.spdx_id, name: json.name, body }, null, 2)}\n`, 'utf8')
	} catch {
		// A read-only cache directory must not fail a publish.
	}
	return { key: normalized, spdxId: String(json?.spdx_id ?? normalized), name: String(json?.name ?? normalized), body, cached: false }
}

/**
 * Build the generated LICENSE entry for a manifest.
 *
 * @param {object} options - generation inputs.
 * @param {string} options.apiBase - GitHub API base URL.
 * @param {string | undefined} options.token - token, when one is available.
 * @param {string} options.key - license key to generate.
 * @param {string} options.copyright - copyright holder named in the text.
 * @param {string} options.cacheDir - license cache directory.
 * @param {Date} [options.now] - clock override, for tests.
 * @returns {Promise<{ path: string, content: string, bytes: number, license: string, cached: boolean }>} the file to commit.
 */
export async function buildLicenseEntry({ apiBase, token, key, copyright, cacheDir, now = new Date() }) {
	const license = await fetchLicense({ apiBase, token, key, cacheDir })
	const content = renderLicense(license.body, { year: String(now.getUTCFullYear()), copyright })
	return {
		path: 'LICENSE',
		content,
		bytes: Buffer.byteLength(content, 'utf8'),
		license: license.spdxId,
		cached: license.cached,
	}
}

export default buildLicenseEntry