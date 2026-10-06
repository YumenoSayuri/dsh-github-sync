/**
 * Git transport.
 *
 * One plugin owns one **persistent local mirror** — a real clone kept under the
 * user's home directory — and every publish is an ordinary commit pushed on top
 * of whatever the remote already has. History therefore accumulates normally:
 * `git log`, `git blame`, and `git revert` all behave the way any GitHub user
 * expects.
 *
 * Why a mirror instead of the plugin directory: the plugin directory is not a
 * repository and must not become one (it is the user's working folder, shared
 * with their editor and their DSH install). The mirror is derived state — the
 * remote plus the clean copy — so it can be thrown away and rebuilt at any time.
 *
 * The token never reaches a command line, an argv array, or a remote URL. Git
 * asks for credentials through a helper that reads a generated file; the token
 * exists only inside that helper's own memory and in the JSON payload it writes
 * back on stdout.
 */

import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { USER_CONFIG } from './config.js'

/**
 * Scratch branch used to build a root commit for a `force` publish. It is never
 * pushed under this name; the configured branch is moved onto the commit.
 */
const SNAPSHOT_BRANCH = 'dsh-snapshot'

/**
 * Read one file from the clean copy, by manifest path (case-insensitive).
 *
 * @param {object} manifest - the clean-copy manifest.
 * @param {string} name - the file name to look for, lower case.
 * @returns {string | undefined} the file text, when it is part of the clean copy.
 */
function manifestText(manifest, name) {
	const file = (manifest.files ?? []).find((candidate) => candidate.path.toLowerCase() === name)
	if (file === undefined || typeof manifest.dir !== 'string') return undefined
	try {
		return readFileSync(join(manifest.dir, file.path), 'utf8')
	} catch {
		return undefined
	}
}

/**
 * Pull `version` out of a package manifest.
 *
 * @param {string | undefined} text - the package.json contents.
 * @returns {string | undefined} the declared version.
 */
function versionOf(text) {
	if (text === undefined) return undefined
	try {
		const value = JSON.parse(text)?.version
		return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
	} catch {
		return undefined
	}
}

/**
 * Check the two publication conventions, and say so when they are broken.
 *
 * Both are warnings rather than blockers: neither is illegal, and refusing to
 * publish over a version number would be worse than publishing with a note. The
 * point is that the human hears about it at the moment it happens, instead of
 * discovering a flat 0.1.0 history months later.
 *
 * @param {object} options - check inputs.
 * @param {object} options.base - the git invocation context.
 * @param {object} options.manifest - the clean-copy manifest.
 * @param {{ code: string, path: string }[]} options.changed - what this commit changes.
 * @param {string | undefined} options.baseRef - the previous published state, if any.
 * @returns {Promise<string[]>} the convention warnings.
 */
async function conventionWarnings({ base, manifest, changed, baseRef }) {
	const warnings = []
	const current = versionOf(manifestText(manifest, 'package.json'))
	if (current === undefined) return warnings
	const previous =
		baseRef === undefined
			? undefined
			: versionOf(
					await run({ ...base, args: ['show', `${baseRef}:package.json`] }).then(
						(result) => result.stdout,
						() => undefined,
					),
				)
	if (previous === undefined) return warnings

	if (changed.length > 0 && previous === current) {
		warnings.push(
			`这次有 ${changed.length} 处变更，但 package.json 的 version 还是 ${current}，没有升版本。` +
				'按约定，有改动的发布应当升版本，并在 README 的「版本历史」里记一行。',
		)
	}
	if (previous !== current) {
		const readme = manifestText(manifest, 'readme.md')
		if (readme !== undefined && !readme.includes(current)) {
			warnings.push(
				`版本从 ${previous} 升到 ${current}，但 README 里找不到 ${current}。` +
					'按约定，README 末尾应有「版本历史」小节，按版本倒序记录（含年月日时分）。',
			)
		}
	}
	return warnings
}

/**
 * Turn git's rejection text into something a human can act on.
 *
 * @param {object} options - context for the message.
 * @param {string} options.repository - `owner/name` being pushed to.
 * @param {string} options.branch - the branch being pushed.
 * @param {string} options.mirror - the mirror directory.
 * @param {string} options.text - git's own stderr.
 * @returns {string} the explanation.
 */
export function explainPushRejection({ repository, branch, mirror, text }) {
	if (/protected branch|protected/i.test(text) && !/non-fast-forward|fetch first/i.test(text)) {
		return (
			`远端 ${repository} 的 ${branch} 分支受保护，推送被拒绝。\n` +
			'这不是本插件能绕过的事情：请在 GitHub 仓库设置里调整分支保护规则（或把本插件推送的身份加进允许列表）。\n\n' +
			`原始信息：\n${text}`
		)
	}
	return (
		`推送被拒绝：远端 ${repository} 的 ${branch} 分支上有本地还没有的提交。\n` +
			'这通常意味着在本次拉取之后、推送之前，远端又变了（他人推送、网页编辑、或另一个工具）。\n' +
			'两个选择：① 直接重跑一次（会先拉取远端再提交，通常就正常了）；' +
			`② 若确实要丢掉远端那些提交，用 github_sync_push 的 force 重建为单次快照。\n\n原始信息：\n${text}`
	)
}

/**
 * Replace every occurrence of the token in a string with a mask.
 *
 * @param {string} text - text that may embed the token.
 * @param {string | undefined} token - the secret to mask.
 * @returns {string} the masked text.
 */
export function maskSecret(text, token) {
	let out = String(text ?? '')
	if (typeof token === 'string' && token.length >= 8) {
		out = out.split(token).join('***')
	}
	return out.replace(/(https?:\/\/)[^@\s/]+:[^@\s/]+@/gi, '$1***@')
}

/**
 * Run one git command.
 *
 * @param {object} options - invocation inputs.
 * @param {string} options.git - git executable.
 * @param {string[]} options.args - arguments; never contains a secret.
 * @param {string} [options.cwd] - working directory.
 * @param {Record<string, string>} [options.env] - extra environment entries.
 * @param {string} [options.token] - a secret to strip from any error text.
 * @param {number} [options.timeoutMs] - hard timeout.
 * @returns {Promise<{ stdout: string, stderr: string }>} captured output.
 */
function run({ git, args, cwd, env, token, timeoutMs = 180_000 }) {
	return new Promise((resolve, reject) => {
		execFile(
			git,
			args,
			{
				cwd,
				timeout: timeoutMs,
				maxBuffer: 32 * 1024 * 1024,
				windowsHide: true,
				env: {
					...process.env,
					// Deterministic, non-interactive, and independent of whatever the
					// user's global git config happens to say about credentials.
					GIT_TERMINAL_PROMPT: '0',
					GIT_CONFIG_NOSYSTEM: '1',
					LC_ALL: 'C',
					...env,
				},
			},
			(error, stdout, stderr) => {
				if (error === null || error === undefined) {
					resolve({ stdout: String(stdout), stderr: String(stderr) })
					return
				}
				if (error.code === 'ENOENT') {
					reject(new Error(`找不到 git 可执行文件「${git}」。请安装 Git，或在 sync.config.json 的 git.executable 里写绝对路径。`))
					return
				}
				const detail = maskSecret(`${stderr || stdout || error.message}`.trim(), token)
				const failure = new Error(`git ${args[0]} 失败（退出码 ${error.code ?? '?'}）：\n${detail}`)
				failure.gitStderr = detail
				failure.exitCode = error.code
				reject(failure)
			},
		)
	})
}

/**
 * Source text of the credential helper written beside the mirrors.
 *
 * Git invokes it as `<command> get` and reads `username=` / `password=` lines
 * from stdout. Anything else — `store`, `erase`, a missing file — exits quietly,
 * because a helper that chats on stderr makes every git error unreadable.
 *
 * @param {string} tokenFile - absolute path of the JSON file holding the token.
 * @returns {string} a complete ESM script.
 */
export function credentialHelperSource(tokenFile) {
	const literal = JSON.stringify(tokenFile)
	return `// Generated by @local/dsh-github-sync. Lives outside every repository.
import { readFileSync } from 'node:fs'

const FILE = ${literal}

function token() {
	try {
		const raw = JSON.parse(readFileSync(FILE, 'utf8'))
		const value = typeof raw?.github?.token === 'string' ? raw.github.token.trim() : ''
		return value === '' ? undefined : value
	} catch {
		return undefined
	}
}

const op = process.argv[2]
if (op === 'get') {
	const value = token()
	if (value !== undefined) {
		process.stdout.write('username=x-access-token\\n')
		process.stdout.write('password=' + value + '\\n')
	}
}
process.exit(0)
`
}

/**
 * Make one mirror's local config self-sufficient: identity, no autocrlf
 * surprises, and exactly our credential helper rather than whatever the user has
 * installed globally.
 *
 * @param {object} options - configuration inputs.
 * @param {string} options.git - git executable.
 * @param {string} options.cwd - the mirror directory.
 * @param {string} options.userName - committer name recorded in commits.
 * @param {string} options.userEmail - committer email recorded in commits.
 * @param {string} options.helperPath - absolute path of the credential helper.
 * @returns {Promise<void>} resolves once the mirror is configured.
 */
async function configureMirror({ git, cwd, userName, userEmail, helperPath }) {
	const base = { git, cwd }
	await run({ ...base, args: ['config', 'user.name', userName] })
	await run({ ...base, args: ['config', 'user.email', userEmail] })
	await run({ ...base, args: ['config', 'core.autocrlf', 'false'] })
	// `credential.helper` is a multi-valued key: it can be added to but not
	// overwritten with a single value, so clear it first and tolerate the case
	// where it was never set. Running this on every publish keeps the mirror's
	// credentials exactly ours instead of accumulating entries.
	await run({ ...base, args: ['config', '--unset-all', 'credential.helper'] }).catch(() => undefined)
	await run({ ...base, args: ['config', '--add', 'credential.helper', `!"${process.execPath}" "${helperPath}"`] })
	await run({ ...base, args: ['config', 'credential.useHttpPath', 'true'] })
}

/**
 * Replace a working tree's contents with exactly the files a manifest describes.
 *
 * `git` itself is preserved; everything else is removed and rewritten, because
 * the mirror's state is a function of the manifest rather than an accumulated
 * pile. Git compares content, so an untouched file produces no diff: deleting
 * and rewriting it is not the same thing as changing it.
 *
 * @param {object} options - sync inputs.
 * @param {string} options.work - the mirror's working directory.
 * @param {Manifest} options.manifest - files to place, relative to `manifest.dir`.
 * @returns {{ written: number, removed: number }} what the sync did.
 */
function syncWorkingTree({ work, manifest }) {
	let removed = 0
	for (const entry of readdirSync(work, { withFileTypes: true })) {
		if (entry.name === '.git') continue
		rmSync(join(work, entry.name), { recursive: true, force: true })
		removed++
	}

	let written = 0
	/**
	 * @param {string} rel - `/`-separated path inside the mirror.
	 * @param {(target: string) => void} placeFile - writes the file's bytes.
	 */
	const place = (rel, placeFile) => {
		const target = join(work, ...rel.split('/'))
		mkdirSync(dirname(target), { recursive: true })
		placeFile(target)
		written++
	}

	for (const file of manifest.files) {
		const source = join(manifest.dir, ...file.path.split('/'))
		place(file.path, (target) => copyFileSync(source, target))
	}
	// Generated content (a license, for instance) has no file on disk to copy.
	for (const extra of manifest.extra ?? []) {
		place(extra.path, (target) => writeFileSync(target, extra.content, 'utf8'))
	}
	return { written, removed }
}

/**
 * Publish one manifest into one repository, as a normal commit.
 *
 * @param {object} options - publish inputs.
 * @param {Manifest} options.manifest - the clean copy to publish.
 * @param {string} options.repository - `owner/name` on GitHub.
 * @param {string} options.mirror - absolute path of this plugin's mirror.
 * @param {string} options.helperPath - absolute path of the credential helper.
 * @param {string} options.branch - the branch to commit on and push.
 * @param {string} options.commitMessage - the commit subject.
 * @param {string} options.git - git executable.
 * @param {string} options.userName - committer name recorded in the commit.
 * @param {string} options.userEmail - committer email recorded in the commit.
 * @param {string | undefined} options.token - GitHub token used for HTTPS auth.
 * @param {string} options.tokenFile - file the credential helper reads.
 * @param {boolean} [options.dryRun] - stage and report, but do not commit or push.
 * @param {boolean} [options.force] - replace the remote branch with this history.
 * @param {string} [options.remoteUrl] - override the remote URL. A GitHub URL is
 *   always derived from `repository`, so nothing in normal operation can point a
 *   real push at an unintended host; this exists so the whole path can be
 *   exercised against a throwaway local bare repository in tests.
 * @returns {Promise<PublishResult>} what changed, and what was pushed.
 */
export async function publish({
	manifest,
	repository,
	mirror,
	helperPath,
	branch,
	commitMessage,
	git,
	userName,
	userEmail,
	token,
	tokenFile,
	dryRun = false,
	force = false,
	remoteUrl,
}) {
	if (manifest.files.length === 0 && (manifest.extra ?? []).length === 0) {
		throw new Error(`干净副本里一个文件都没有：${manifest.dir}\n（检查 include 白名单，或 sync.config.json 的排除规则）`)
	}

	// The helper sits beside the mirrors, never inside one, so it can never be
	// staged by the `add -A` that follows.
	mkdirSync(dirname(helperPath), { recursive: true })
	writeFileSync(helperPath, credentialHelperSource(tokenFile), 'utf8')

	const url = typeof remoteUrl === 'string' && remoteUrl !== '' ? remoteUrl : `https://github.com/${repository}.git`
	const firstPublish = !existsSync(join(mirror, '.git'))
	mkdirSync(dirname(mirror), { recursive: true })

	const base = { git, cwd: mirror }
	if (firstPublish) {
		mkdirSync(mirror, { recursive: true })
		await run({ ...base, args: ['init', '--quiet', '--initial-branch', branch] })
	}
	await configureMirror({ git, cwd: mirror, userName, userEmail, helperPath })

	// Point the mirror at the target and pick up whatever is already there, so a
	// commit is always a fast-forward on top of the remote instead of a
	// replacement of it.
	const remotes = await run({ ...base, args: ['remote'] })
	const hasOrigin = remotes.stdout.split('\n').map((line) => line.trim()).includes('origin')
	if (hasOrigin) await run({ ...base, args: ['remote', 'set-url', 'origin', url] })
	else await run({ ...base, args: ['remote', 'add', 'origin', url] })

	await run({ ...base, args: ['fetch', '--quiet', '--tags', 'origin'], token, timeoutMs: 600_000 })

	const remoteRef = `refs/remotes/origin/${branch}`
	const remoteExists = await run({ ...base, args: ['rev-parse', '--verify', '--quiet', remoteRef] }).then(
		() => true,
		() => false,
	)

	if (force) {
		// The original behaviour, kept as an explicit choice: the remote branch is
		// replaced by a single fresh commit of the clean copy, and whatever history
		// it had is discarded. A plain `--force` on top of the fetched tip would be
		// a no-op — the tip is already an ancestor — so the new commit has to be a
		// root commit for this to mean anything. It is what a human wants when a
		// commit must be gone (a secret, a mistake), not when they merely want to
		// publish.
		await run({ ...base, args: ['checkout', '--quiet', '--force', '--detach'] }).catch(() => undefined)
		await run({ ...base, args: ['branch', '--quiet', '--force', '--delete', SNAPSHOT_BRANCH] }).catch(() => undefined)
		await run({ ...base, args: ['checkout', '--quiet', '--force', '--orphan', SNAPSHOT_BRANCH] })
	} else if (remoteExists) {
		// Base this publish on the remote's tip, so a commit made elsewhere — a web
		// edit, a colleague, another tool — is preserved and this publish lands on
		// top of it instead of erasing it.
		await run({ ...base, args: ['checkout', '--quiet', '--force', '-B', branch, remoteRef] })
	} else {
		await run({ ...base, args: ['checkout', '--quiet', '--force', '-B', branch] })
	}
	const baseCommits = Number(
		(await run({ ...base, args: ['rev-list', '--count', 'HEAD'] }).then((result) => result.stdout.trim(), () => '0')) || 0,
	)

	const synced = syncWorkingTree({ work: mirror, manifest })
	await run({ ...base, args: ['add', '-A', '--force', '.'] })

	const status = await run({ ...base, args: ['status', '--porcelain'] })
	const changed = status.stdout
		.split('\n')
		.map((line) => line.replace(/\s+$/, ''))
		.filter((line) => line !== '')
		.map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3).trim() }))

	const head = await run({ ...base, args: ['rev-parse', 'HEAD'] }).then(
		(result) => result.stdout.trim(),
		() => undefined,
	)

	// Convention checks. A version number and its record in the README are what a
	// stranger reads first, and "I forgot to bump it" stays invisible for a long
	// time — so these are looked up rather than trusted to anyone's memory.
	const conventions = await conventionWarnings({
		base,
		manifest,
		changed,
		baseRef: remoteExists && !force ? remoteRef : undefined,
	})

	const common = {
		sha: head,
		branch,
		files: manifest.files.length,
		generated: (manifest.extra ?? []).map((entry) => entry.path),
		written: synced.written,
		removed: synced.removed,
		changed,
		warnings: conventions,
		baseCommits,
		mirror,
		firstPublish,
	}

	if (changed.length === 0) {
		return { ...common, unchanged: true, pushed: false, historyDepth: baseCommits }
	}
	if (dryRun) {
		return { ...common, unchanged: false, pushed: false, historyDepth: baseCommits }
	}

	// A token is only required when the destination is actually GitHub. A test
	// destination (a local bare repository) authenticates by path, not by token.
	if (url.startsWith('https://github.com/') && (typeof token !== 'string' || token.trim() === '')) {
		throw new Error(
			'没有可用的 GitHub token，无法推送。\n' +
				`把 token 写进 ${USER_CONFIG} 的 github.token，或设置环境变量 GITHUB_TOKEN。`,
		)
	}

	const commit = await run({ ...base, args: ['commit', '--quiet', '--no-gpg-sign', '-m', String(commitMessage)] })
	const sha = (await run({ ...base, args: ['rev-parse', 'HEAD'] })).stdout.trim()
	const historyDepth = Number((await run({ ...base, args: ['rev-list', '--count', 'HEAD'] })).stdout.trim()) || 0
	if (force) {
		// Put the configured branch name on the fresh root commit so the mirror's
		// next publish continues from the new history rather than the old one.
		await run({ ...base, args: ['branch', '--quiet', '--force', branch, 'HEAD'] })
		await run({ ...base, args: ['checkout', '--quiet', '--force', branch] }).catch(() => undefined)
	}

	// A normal push. A rejection is reported and never overridden by default:
	// someone else's work is on the remote, and silently replacing it is not this
	// plugin's call — the caller has to ask for `force` explicitly.
	const pushArgs = ['push', 'origin', `HEAD:refs/heads/${branch}`]
	if (force) pushArgs.splice(1, 0, '--force')
	let push
	try {
		push = await run({ ...base, args: pushArgs, token, timeoutMs: 600_000 })
	} catch (error) {
		const text = String(error.gitStderr ?? error.message ?? '')
		if (/non-fast-forward|fetch first|rejected|stale info|protected/i.test(text)) {
			throw new Error(explainPushRejection({ repository, branch, mirror, text }))
		}
		throw error
	}

	return {
		...common,
		unchanged: false,
		sha,
		historyDepth,
		pushed: true,
		pushOutput: `${push.stdout}${push.stderr}`.trim(),
		commitOutput: `${commit.stdout}${commit.stderr}`.trim(),
	}
}

/**
 * Discard one plugin's mirror so the next publish re-aligns with the remote.
 *
 * @param {string} mirror - absolute mirror path.
 * @returns {boolean} true when a mirror was present and is now gone.
 */
export function dropMirror(mirror) {
	if (!existsSync(mirror)) return false
	rmSync(mirror, { recursive: true, force: true })
	return true
}

export default publish
