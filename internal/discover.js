/**
 * Plugin discovery.
 *
 * A plugin is any directory under a scan root whose `package.json` carries a
 * DSH marker: `dsh.bundle` (it installs as a profile layer), `dsh.client`
 * (it has a browser half), or a `dsh.keywords` list naming DSH. Anything else in
 * the workspace — scratch folders, notes, image dumps — is ignored, so the
 * workspace can stay messy without polluting the sync list.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Directory names never scanned as plugins. */
const SKIP_DIRS = new Set(['node_modules', '.git', '_scratch', '_research', '.dsh-meow'])

/**
 * Read one package manifest.
 *
 * @param {string} dir - candidate plugin directory.
 * @returns {{ name: string, version: string, description?: string, hasBundle: boolean, hasClient: boolean, keywords: string[] } | undefined}
 *   the recognized manifest, or undefined when the directory is not a plugin.
 */
function readPluginManifest(dir) {
	let text
	try {
		text = readFileSync(join(dir, 'package.json'), 'utf8')
	} catch {
		return undefined
	}
	let pkg
	try {
		pkg = JSON.parse(text.replace(/^\uFEFF/, ''))
	} catch {
		return undefined
	}
	if (pkg === null || typeof pkg !== 'object') return undefined
	const dsh = pkg.dsh !== null && typeof pkg.dsh === 'object' ? pkg.dsh : undefined
	const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : []
	const hasBundle = dsh !== undefined && dsh.bundle !== undefined && dsh.bundle !== null
	const hasClient = dsh !== undefined && dsh.client !== undefined && dsh.client !== null
	const keywordMarked = keywords.some((word) => word === 'dsh' || word === 'dsh-plugin')
	if (!hasBundle && !hasClient && !keywordMarked) return undefined
	return {
		name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : undefined,
		version: typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0',
		description:
			typeof pkg.description === 'string' && pkg.description !== ''
				? pkg.description
				: typeof pkg.meta?.description === 'string'
					? pkg.meta.description
					: undefined,
		hasBundle,
		hasClient,
		keywords,
	}
}

/**
 * Strip a package scope from a package name.
 *
 * @param {string} name - package name, possibly scoped.
 * @returns {string} the bare name.
 */
export function bareName(name) {
	const text = String(name ?? '')
	const slash = text.lastIndexOf('/')
	return slash === -1 ? text : text.slice(slash + 1)
}

/** The prefix every DSH plugin carries — on its folder, its package, its repository. */
export const PLUGIN_PREFIX = 'dsh-'

/**
 * Whether a plugin folder name follows the `dsh-` convention.
 *
 * The rule is about the **folder**: a plugin on disk is identified by its
 * directory, so that is what must be named `dsh-…`. A package whose `name` field
 * happens to carry the prefix does not excuse a folder that lacks it, and a
 * folder that carries it is not invalidated by a package name that does not.
 *
 * @param {string} dirName - the plugin's directory name.
 * @returns {boolean} true when the convention is met.
 */
export function hasPluginPrefix(dirName) {
	return String(dirName ?? '').startsWith(PLUGIN_PREFIX)
}

/**
 * The conventional name a folder should have, for telling a human what to rename
 * it to. Exactly one prefix is applied, so `dsh-sticker` stays `dsh-sticker`
 * rather than becoming `dsh-dsh-sticker`.
 *
 * @param {string} dirName - the plugin's current directory name.
 * @returns {string} the conforming name.
 */
export function conformingName(dirName) {
	const text = String(dirName ?? '')
	const stem = text.startsWith(PLUGIN_PREFIX) ? text.slice(PLUGIN_PREFIX.length) : text
	return stem === '' ? text : `${PLUGIN_PREFIX}${stem}`
}

/**
 * The configured keys for one plugin: an explicit `dir` matches, the directory
 * name matches, the package name matches, or the bare package name matches.
 *
 * @param {Record<string, Record<string, unknown>>} plugins - configured entries.
 * @param {string} dirName - directory name on disk.
 * @param {string} packageName - package name from the manifest.
 * @returns {Record<string, unknown> | undefined} the entry, and its config key.
 */
function entryFor(plugins, dirName, packageName) {
	const bare = bareName(packageName)
	for (const [key, entry] of Object.entries(plugins)) {
		if (entry.dir !== undefined && entry.dir === dirName) return { key, entry }
		if (key === dirName || key === packageName || key === bare) return { key, entry }
	}
	return undefined
}

/**
 * Discover plugins across every scan root.
 *
 * Roots are tried in order and a directory found twice is reported once, keeping
 * the first root that saw it. Within a root, both the root itself and its direct
 * children are candidates, so a workspace that groups plugins one level down
 * works as well as a flat one.
 *
 * @param {object} options - discovery inputs.
 * @param {string[]} options.roots - absolute directories to scan, in priority order.
 * @param {Record<string, Record<string, unknown>>} options.plugins - configured entries.
 * @returns {{ plugins: DiscoveredPlugin[], roots: { path: string, exists: boolean }[] }} discovery result.
 */
export function discoverPlugins({ roots, plugins }) {
	/** @type {Map<string, DiscoveredPlugin>} */
	const found = new Map()
	const rootReport = []

	for (const root of roots) {
		let exists = false
		try {
			exists = statSync(root).isDirectory()
		} catch {
			exists = false
		}
		rootReport.push({ path: root, exists })
		if (!exists) continue

		/** @type {{ dir: string, dirName: string }[]} */
		const candidates = [{ dir: root, dirName: root.split(/[\\/]/).pop() ?? root }]
		let children = []
		try {
			children = readdirSync(root, { withFileTypes: true })
		} catch {
			children = []
		}
		for (const child of children) {
			if (!child.isDirectory()) continue
			if (SKIP_DIRS.has(child.name)) continue
			if (child.name.startsWith('.')) continue
			candidates.push({ dir: join(root, child.name), dirName: child.name })
		}

		for (const candidate of candidates) {
			const manifest = readPluginManifest(candidate.dir)
			if (manifest === undefined) continue
			const key = String(manifest.name ?? candidate.dirName)
			if (found.has(key)) continue
			const configured = entryFor(plugins, candidate.dirName, manifest.name ?? candidate.dirName)
			const entry = configured?.entry ?? {}
			// The repository is named after the plugin folder, which is the plugin's
			// identity on disk. It is never silently "fixed up": a folder that breaks
			// the dsh- convention is reported as such and blocked in planning, so the
			// human renames the folder instead of discovering a renamed repository.
			const explicitRepo = entry.repo === undefined ? undefined : String(entry.repo)
			const repo = explicitRepo ?? candidate.dirName
			found.set(key, {
				key,
				configKey: configured?.key,
				dir: candidate.dir,
				dirName: candidate.dirName,
				relativeDir: relative(root, candidate.dir) === '' ? '.' : relative(root, candidate.dir),
				root,
				name: manifest.name,
				version: manifest.version,
				description: entry.description ?? manifest.description,
				repo,
				repoFrom: explicitRepo === undefined ? 'folder-name' : 'config',
				folderPrefixOk: hasPluginPrefix(candidate.dirName),
				suggestedName: conformingName(candidate.dirName),
				visibility: entry.visibility,
				enabled: entry.enabled !== false,
				entry,
				hasBundle: manifest.hasBundle,
				hasClient: manifest.hasClient,
			})
		}
	}

	return {
		plugins: [...found.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
		roots: rootReport,
	}
}

export default discoverPlugins