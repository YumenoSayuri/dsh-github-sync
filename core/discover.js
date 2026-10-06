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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Directory names never scanned as plugins. */
const SKIP_DIRS = new Set(['node_modules', '.git', '_scratch', '_research', '.dsh-meow'])

/**
 * Read one package manifest, with no opinion about what it is.
 *
 * Separate from the plugin test on purpose: reading what a directory declares is
 * useful for any directory — an explicitly named project has a name and a version
 * worth reporting — while the fingerprint test belongs only to the scan.
 *
 * @param {string} dir - candidate directory.
 * @returns {{ name: string, version: string, description?: string, hasBundle: boolean, hasClient: boolean, keywords: string[] } | undefined}
 *   the manifest, or undefined when there is no readable `package.json`.
 */
function readManifest(dir) {
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
 * Read a manifest and require a DSH marker, which is what makes a directory part
 * of the workspace scan.
 *
 * @param {string} dir - candidate directory.
 * @returns {object | undefined} the manifest, or undefined when it is not a DSH plugin.
 */
function readPluginManifest(dir) {
	const manifest = readManifest(dir)
	if (manifest === undefined) return undefined
	const keywordMarked = manifest.keywords.some((word) => word === 'dsh' || word === 'dsh-plugin')
	if (!manifest.hasBundle && !manifest.hasClient && !keywordMarked) return undefined
	return manifest
}

/**
 * The evidence that a directory is a DSH plugin, in the order it is trusted.
 *
 * Reported rather than inferred silently: whether a target is a DSH plugin
 * decides which conventions apply to it (the `dsh-` folder prefix, the
 * `dsh-plugin` topic), so the conclusion has to be visible to be argued with.
 *
 * @param {{ hasBundle: boolean, hasClient: boolean, keywords: string[] } | undefined} manifest - the recognized manifest.
 * @returns {{ kind: string, fingerprint: string[] }} the classification and its evidence.
 */
function classify(manifest) {
	const fingerprint = []
	if (manifest?.hasBundle === true) fingerprint.push('package.json 的 dsh.bundle')
	if (manifest?.hasClient === true) fingerprint.push('package.json 的 dsh.client')
	if (Array.isArray(manifest?.keywords) && manifest.keywords.some((word) => word === 'dsh' || word === 'dsh-plugin')) {
		fingerprint.push('package.json 的 keywords 含 dsh')
	}
	return { kind: fingerprint.length > 0 ? 'dsh-plugin' : 'project', fingerprint }
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

/**
 * Describe any directory: its package manifest, its kind, and the evidence.
 *
 * Unlike the workspace scan below, this does not require a DSH fingerprint — it
 * is what makes an explicitly named directory publishable. The scan exists so a
 * workspace can be listed without anyone naming a thing; it is not a permission
 * system, and a directory that a human (or the session working in it) names
 * explicitly needs no fingerprint to be a legitimate target.
 *
 * @param {string} dir - absolute directory path.
 * @returns {{ manifest: object | undefined, kind: string, fingerprint: string[] }} what the directory is.
 */
export function describeDirectory(dir) {
	// The manifest is read without the plugin test: a named directory's name and
	// version are worth reporting whatever it turns out to be.
	const manifest = readManifest(dir)
	return { manifest, ...classify(manifest) }
}

/**
 * Build a publish target for one explicitly named directory.
 *
 * @param {object} options - target inputs.
 * @param {string} options.dir - the directory, as the human wrote it.
 * @param {object} [options.entry] - configuration for this target, if any.
 * @param {string} options.dshHome - the harness home directory, refused as a target.
 * @returns {{ target?: object, problem?: string }} the target, or why it was refused.
 */
export function explicitTarget({ dir, entry = {}, dshHome }) {
	const absolute = resolve(dir)
	let info
	try {
		info = statSync(absolute)
	} catch {
		return { problem: `路径不存在：${absolute}` }
	}
	if (!info.isDirectory()) return { problem: `不是目录：${absolute}` }

	// The one refusal here that guards a secret rather than a convention: the
	// harness home holds the token, every transcript, and the publish mirrors, so
	// a target that contains it — or sits inside it — would publish those.
	const into = relative(absolute, dshHome)
	const outOf = relative(dshHome, absolute)
	const wraps = into !== '' && !into.startsWith('..') && !isAbsolute(into)
	const inside = outOf !== '' && !outOf.startsWith('..') && !isAbsolute(outOf)
	if (into === '' || wraps || inside) {
		return {
			problem:
				`拒绝把「${absolute}」作为发布目标：它与 DSH 自己的目录（${dshHome}）重叠，` +
				'那里存着你的 GitHub token、所有会话记录和发布镜像。请指定一个明确的产物目录。',
		}
	}

	const { manifest, kind, fingerprint } = describeDirectory(absolute)
	const dirName = basename(absolute)
	const explicitRepo = entry.repo === undefined ? undefined : String(entry.repo)
	return {
		target: {
			key: `path:${absolute}`,
			configKey: undefined,
			dir: absolute,
			dirName,
			relativeDir: absolute,
			root: dirname(absolute),
			name: manifest?.name ?? dirName,
			version: manifest?.version ?? '0.0.0',
			description: entry.description ?? manifest?.description,
			repo: explicitRepo ?? dirName,
			repoFrom: explicitRepo === undefined ? 'folder-name' : 'config',
			kind: entry.kind === undefined ? kind : String(entry.kind),
			fingerprint,
			folderPrefixOk: hasPluginPrefix(dirName),
			suggestedName: conformingName(dirName),
			visibility: entry.visibility,
			enabled: entry.enabled !== false,
			entry,
			hasBundle: manifest?.hasBundle === true,
			hasClient: manifest?.hasClient === true,
			explicit: true,
		},
	}
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
			// the dsh- convention is reported with the exact rename, so the human
			// renames the folder instead of discovering a renamed repository.
			const explicitRepo = entry.repo === undefined ? undefined : String(entry.repo)
			const repo = explicitRepo ?? candidate.dirName
			const { kind, fingerprint } = classify(manifest)
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
				kind: entry.kind === undefined ? kind : String(entry.kind),
				fingerprint,
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

