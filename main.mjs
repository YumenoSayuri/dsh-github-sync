/**
 * `@local/dsh-github-sync` — Host half.
 *
 * Publishes each DSH plugin in the workspace to its own GitHub repository as a
 * clean copy, on explicit instruction only.
 *
 * The composition, and why it is shaped this way:
 *
 *  - `ctx.systemPrompt.section` carries the operating instructions, but its text
 *    function returns an empty string unless the calling agent is armed. Ordinary
 *    conversation therefore pays zero tokens for this plugin.
 *  - `/git` is the only thing that arms an agent. It arms exactly one turn, and
 *    the human's text after the command rides along as the instruction for that
 *    turn, so `/git push the sticker plugin` is one gesture.
 *  - `ctx.tools.guard` denies the push tool for any unarmed agent, so "cannot
 *    upload by itself" is enforced rather than merely requested. The two weaker
 *    tools (`status`, `plan`) stay freely callable: they read and they dry-run,
 *    they never write to GitHub, and an agent that can answer "what would you
 *    upload?" without being armed is useful rather than dangerous.
 *
 * Nothing in this plugin runs on a timer, on session start, or on a file change.
 * There is no code path that uploads without a human asking for it in the turn
 * that performs the upload.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureUserConfig, loadConfig, USER_CONFIG, writeUserToken, clearUserToken } from './core/config.js'
import { humanBytes, plan as buildPlan, execute, plan as planSync, resolveGit, scanRoots, writeStatus } from './core/sync.js'
import { arm, armMode, cwdOf, gateText, isArmed, isPushArmed, observeStep, TOOLS, wantsPush } from './core/prompt.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Deep-freeze a value in place, the way the harness freezes its own messages.
 *
 * @param {unknown} value - the value to freeze.
 * @returns {unknown} the same value, frozen.
 */
function deepFreeze(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const nested of Object.values(value)) deepFreeze(nested)
	}
	return value
}

/**
 * Build an identified user-role message without the harness factory.
 *
 * The harness's own `createUserMessage` (`@deepseek-ai/dsh-llm`) is exactly
 * `deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))`;
 * this is the same thing, and it exists for one reason. A message reaching
 * `agent.steer()` is written into the session journal as a `user/message` event
 * verbatim, and replay rejects an event whose `id` is not a non-empty string —
 * failing the load of the whole session, not just that turn. Depending on an
 * app-internal package to get that id would trade a small correctness risk for a
 * much larger one: an unresolvable import fails the *bundle*, which silently
 * removes the `/git` gate and every tool with it.
 *
 * @param {object} input - message content and source.
 * @returns {object} an identified, frozen user message.
 */
function localUserMessage(input) {
	return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/** The harness factory once it resolves, or undefined while unknown/absent. */
let harnessUserMessage

/** Set once the factory has been looked up, so the attempt happens at most once. */
let factoryLookup

/**
 * Look up the harness message factory in the background.
 *
 * Resolution is attempted once, at load, and never awaited: the app's packages
 * live inside its own archive (`/dsh/node_modules/...`), which a plugin loaded
 * from a workspace directory may or may not resolve, so both outcomes are normal.
 * Whichever factory wins, a message carries a real `id`.
 *
 * @returns {Promise<void>} resolves once the lookup has been attempted.
 */
function primeUserMessageFactory() {
	if (factoryLookup !== undefined) return factoryLookup
	factoryLookup = import('@deepseek-ai/dsh-llm').then(
		(module) => {
			if (typeof module?.createUserMessage === 'function') harnessUserMessage = module.createUserMessage
		},
		() => undefined,
	)
	return factoryLookup
}

/**
 * Create the user message `/git` injects.
 *
 * @param {object} input - message content and source.
 * @returns {object} an identified, frozen user message.
 */
function userMessage(input) {
	return (harnessUserMessage ?? localUserMessage)(input)
}

/** This package's own version, reported in diagnostics. */
const VERSION = (() => {
	try {
		return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version ?? '0.0.0'
	} catch {
		return '0.0.0'
	}
})()

/** Prompt sections this plugin owns; one order fits between persona and tools. */
const SECTION_ORDER = 5100

/** The command name, without its slash. */
const COMMAND = 'git'

/** The session working directory most recently seen per agent. */
const lastCwd = new WeakMap()

/**
 * The workspace to scan for a call made by this agent, falling back to the
 * configured root and then the process directory.
 *
 * @param {object | undefined} agent - the calling agent.
 * @param {ResolvedConfig} config - resolved configuration.
 * @returns {string | undefined} the directory to scan.
 */
function resolveCwd(agent, config) {
	return cwdOf(agent) ?? lastCwd.get(agent) ?? config.workspaceRoot ?? process.cwd()
}

/**
 * Render the human-facing status report.
 *
 * @param {object} options - rendering inputs.
 * @param {string | undefined} cwd - the workspace being scanned.
 * @returns {string} a report suitable for `/git` output and the status tool.
 */
function statusReport(cwd) {
	const config = loadConfig()
	const git = resolveGit(config.git.executable)
	const roots = scanRoots(config, cwd)
	const discovery = buildPlan({ config, cwd, only: [] })
	const lines = []

	lines.push('GitHub 同步 — 状态')
	lines.push('')
	lines.push(`  插件版本      ${VERSION}`)
	lines.push(`  GitHub 账号   ${config.github.owner === '' ? '未配置（推不了，需要填 github.owner）' : config.github.owner}`)
	lines.push(
		`  Token         ${
			typeof config.github.token === 'string' && config.github.token !== ''
				? `已提供（来源：${config.github.tokenSource}）`
				: `缺失（把 token 写进 ${USER_CONFIG} 的 github.token）`
		}`,
	)
	lines.push(`  git           ${git.ok ? git.resolved : `不可用 — ${git.hint}`}`)
	lines.push(`  配置文件      ${config.files.user ?? `${USER_CONFIG}（还没有，已生成模板）`}`)
	lines.push(`  仓库 topics   ${config.github.topics.length === 0 ? '（未启用）' : config.github.topics.join('、')}${config.github.topics.includes('dsh-plugin') ? `  → https://github.com/topics/dsh-plugin` : ''}`)
	lines.push(`  开源协议      ${config.github.license ?? '（未配置自动生成，缺失时仅告警）'}${config.github.license ? `，版权方 ${config.github.copyright || '（未设置）'}` : ''}`)
	lines.push(`  本地镜像      ${config.mirrorsDir}`)
	lines.push(`  单文件上限    ${humanBytes(config.maxFileBytes)}（GitHub 硬上限为 100 MiB；超过 50 MiB 会警告但可推）`)
	lines.push(
		`  提交署名      ${
			config.git.userEmail !== undefined
				? `${config.git.userName ?? '（名字按账号派生）'} <${config.git.userEmail}>  邮箱来自配置`
				: config.git.userName !== undefined
					? `${config.git.userName} <（邮箱按账号派生的 noreply 地址）>  名字来自配置`
					: '留空 → 名字与邮箱都按 token 所属账号派生（noreply 邮箱可关联头像且不暴露真实邮箱）'
		}`,
	)
	lines.push(`  推送方式      每个插件一个独立仓库；默认增量提交、普通推送（不覆盖远端），可用 force 显式强推`)
	lines.push(`  命名约定      dsh- 前缀，严重度 ${config.naming}${config.naming === 'block' ? '（不合规会阻断）' : config.naming === 'warn' ? '（不合规只警告）' : '（不检查）'}；只对 DSH 插件生效`)
	for (const warning of config.warnings ?? []) {
		lines.push('')
		lines.push(`  ! ${warning}`)
	}
	lines.push('')
	lines.push(`  扫描目录（${roots.length}）：`)
	for (const root of discovery.roots) lines.push(`    ${root.exists ? '✓' : '✗'} ${root.path}`)
	lines.push('')
	if (discovery.entries.length === 0) {
		lines.push('  没有发现任何插件（需要 package.json 里带 dsh.bundle / dsh.client / dsh 关键字）。')
	} else {
		lines.push(`  发现 ${discovery.entries.length} 个插件：`)
		for (const entry of discovery.entries) {
			const { plugin, manifest } = entry
			const state = entry.skipReason !== undefined ? '已关闭' : entry.blockers.length > 0 ? '有问题' : '可推送'
			const kind = entry.plugin.kind === 'dsh-plugin' ? 'DSH 插件' : '普通项目'
			lines.push(
				`    [${state}] ${plugin.repo}  ←  ${plugin.relativeDir === '.' ? '.' : plugin.relativeDir}` +
					`  [${kind}]` +
					`  (${plugin.name}@${plugin.version}, ${manifest.mode === 'allowlist' ? '白名单' : '默认排除'}, ` +
					`${manifest.files.length} 个文件 / ${humanBytes(manifest.totalBytes)})`,
			)
			for (const warning of entry.warnings ?? []) lines.push(`        ! ${warning}`)
			for (const blocker of entry.blockers) lines.push(`        ✗ ${blocker}`)
			if (entry.skipReason !== undefined) lines.push(`        - ${entry.skipReason}`)
		}
	}
	for (const problem of discovery.problems) lines.push(`  ! ${problem}`)
	return lines.join('\n')
}

/**
 * Render the dry-run plan.
 *
 * @param {object} options - rendering inputs.
 * @param {string | undefined} cwd - the workspace being scanned.
 * @param {string[] | undefined} only - plugin filter.
 * @param {boolean} verbose - list every excluded path.
 * @returns {string} the report.
 */
function planReport({ cwd, only, verbose }) {
	const config = loadConfig()
	const planned = planSync({ config, cwd, only })
	const lines = []
	lines.push(`GitHub 同步 — 试运行（不会推送任何东西）`)
	lines.push('')
	if (planned.entries.length === 0) {
		lines.push('  没有匹配的插件。')
		for (const problem of planned.problems) lines.push(`  ! ${problem}`)
		return lines.join('\n')
	}
	for (const entry of planned.entries) {
		const { plugin, manifest } = entry
		lines.push(`■ ${plugin.repo}  (${plugin.name}@${plugin.version})`)
		lines.push(
			`  目录        ${plugin.dir}${plugin.explicit === true ? '   （显式给出的路径，不在扫描结果里）' : ''}`,
		)
		lines.push(
			`  判定        ${plugin.kind === 'dsh-plugin' ? 'DSH 插件' : '普通项目（非 DSH 插件）'}` +
				`${plugin.fingerprint.length > 0 ? `  ← 依据：${plugin.fingerprint.join('、')}` : '  ← 没有 DSH 指纹'}`,
		)
		lines.push(`  仓库        ${entry.repository ?? '（未配置 github.owner）'}  [${entry.visibility}]`)
		lines.push(`  仓库 topics ${entry.topics.length === 0 ? '（不打标签）' : entry.topics.join('、')}`)
		lines.push(
			`  开源协议    ${
				entry.licenseFile !== undefined
					? `沿用插件里的 ${entry.licenseFile}`
					: entry.licenseToGenerate !== undefined
						? `缺失，将生成 ${entry.licenseToGenerate}（写入提交里的 LICENSE）`
						: '缺失，且未配置自动生成（建议设 github.license）'
			}`,
		)
		lines.push(`  本地镜像    ${entry.mirror}`)
		lines.push(`  模式        ${manifest.mode === 'allowlist' ? 'include 白名单' : '默认排除 + .gitignore'}`)
		lines.push(`  会推送      ${manifest.files.length} 个文件 / ${humanBytes(manifest.totalBytes)}`)
		lines.push(`  会排除      ${manifest.excluded.length} 项`)
		if (manifest.secrets.length > 0) {
			lines.push(`  ⚠ 检出密钥  ${manifest.secrets.length} 个文件被拦下，不会上传：`)
			for (const item of manifest.secrets) lines.push(`      ${item.path}  —  ${item.kind}`)
		}
		if (entry.skipReason !== undefined) lines.push(`  状态        跳过 — ${entry.skipReason}`)
		for (const blocker of entry.blockers) lines.push(`  ✗ 阻断：${blocker}`)
		for (const warning of entry.warnings ?? []) lines.push(`  ! 警告：${warning}`)

		if (verbose) {
			lines.push('  文件：')
			for (const file of manifest.files) lines.push(`    + ${file.path}  (${humanBytes(file.bytes)})`)
			lines.push('  排除：')
			for (const item of manifest.excluded) lines.push(`    - ${item.path}  — ${item.reason}`)
		} else {
			const sample = manifest.excluded.slice(0, 8)
			if (sample.length > 0) {
				lines.push(`  排除示例（用 verbose 看全部）：`)
				for (const item of sample) lines.push(`    - ${item.path}  — ${item.reason}`)
			}
		}
		lines.push('')
	}
	for (const problem of planned.problems) lines.push(`  ! ${problem}`)
	return lines.join('\n')
}

/**
 * Render the result of a real push.
 *
 * @param {Awaited<ReturnType<typeof execute>>} outcome - the execution outcome.
 * @param {boolean} dryRun - whether the push was a dry run.
 * @returns {string} the report.
 */
function pushReport(outcome, dryRun) {
	const lines = []
	lines.push(dryRun ? 'GitHub 同步 — 试运行结果（没有提交，也没有推送）' : 'GitHub 同步 — 推送结果')
	if (outcome.identity !== undefined) lines.push(`  身份        ${outcome.identity.login}（${outcome.identity.type}）`)
	if (outcome.committer !== undefined) {
		lines.push(`  提交署名    ${outcome.committer.name} <${outcome.committer.email}>  ${outcome.committer.source}`)
	}
	for (const warning of outcome.warnings) lines.push(`  ! ${warning}`)
	lines.push('')
	for (const result of outcome.results) {
		const mark =
			result.outcome === 'failed' ? '✗' : result.outcome === 'skipped' || result.outcome === 'unchanged' ? '-' : '✓'
		lines.push(`${mark} ${result.plugin}  [${result.outcome}]  ${result.files} 个文件 / ${humanBytes(result.bytes)}`)
		for (const detail of result.detail) lines.push(`    ${detail}`)
	}
	const failed = outcome.results.filter((result) => result.outcome === 'failed').length
	const changed = outcome.results.filter((result) => result.changed?.length > 0).length
	const unchanged = outcome.results.filter((result) => result.outcome === 'unchanged').length
	lines.push('')
	lines.push(
		`合计：${outcome.results.length} 个插件，有变更 ${changed}，无变更 ${unchanged}，失败 ${failed}。` +
			(dryRun ? '（试运行，远端未改动）' : ''),
	)
	return lines.join('\n')
}

/**
 * The overlay text `/git` steers the model with.
 *
 * @param {string | undefined} cwd - the workspace being scanned.
 * @param {string} request - the human's text after `/git`.
 * @returns {string} the message body.
 */
function overlay(cwd, request) {
	const config = loadConfig()
	const planned = planSync({ config, cwd, only: [] })
	const ready = planned.entries.filter((entry) => entry.skipReason === undefined && entry.blockers.length === 0)
	const mode = wantsPush(request) ? 'push' : 'investigate'
	const lines = []
	lines.push(mode === 'push' ? '`/git` 已触发 GitHub 同步 —— **推送轮**。' : '`/git` 已触发 GitHub 同步 —— **调查轮（只读）**。')
	lines.push('')
	if (mode === 'investigate') {
		lines.push(
			'这一轮不推送：`github_sync_push` 会被拒绝。把该查的查完、把要点讲清楚（要推哪些、推什么、有什么要决定的），',
		)
		lines.push('最后给出建议，并说明"要真正上传，请再发一条 /git 推送 …"。')
	} else {
		lines.push('这一轮允许上传。先试运行把要推的内容讲清楚，再推——只推下面这个要求覆盖到的范围。')
	}
	lines.push('')
	if (request.trim() === '') {
		lines.push('你没有在 /git 后面写具体要求。')
	} else {
		lines.push(`你的要求是：${request.trim()}`)
	}
	lines.push('')
	lines.push(`- 目标（${ready.length}/${planned.entries.length} 个可推送）：`)
	for (const entry of planned.entries) {
		const flag = entry.blockers.length > 0 || entry.skipReason !== undefined ? '（当前不可推送）' : ''
		const kind = entry.plugin.kind === 'dsh-plugin' ? `DSH 插件，依据 ${entry.plugin.fingerprint.join('、')}` : '普通项目（非 DSH 插件）'
		lines.push(`    - ${entry.plugin.repo}${flag} —— ${kind}`)
		for (const warning of entry.warnings ?? []) lines.push(`        ! ${warning}`)
		for (const blocker of entry.blockers) lines.push(`        ✗ ${blocker}`)
	}
	lines.push(`- GitHub 账号：${config.github.owner === '' ? '未配置，推不了' : config.github.owner}`)
	lines.push(`- Token：${typeof config.github.token === 'string' && config.github.token !== '' ? '已有' : '缺失'}`)
	lines.push(`- 命名约定严重度：${config.naming}（dsh- 前缀只是建议，默认 warn，不阻断）`)
	lines.push('')
	lines.push(
		mode === 'push'
			? '按规则做：先 `github_sync_plan` 试运行并把要点讲清楚，然后 `github_sync_push`；本插件的推送工具只在这一轮里可用。'
			: '按规则做：用 `github_sync_status` / `github_sync_plan` 把事实查清楚并报告；**本轮不要尝试推送**。',
	)
	return lines.join('\n')
}

/**
 * Hard dependencies. Both are load-bearing: without `systemPrompt` there is no
 * gated instruction surface, and without `tools` there is no way to act. The
 * optional services (`commands`, `connection`) are reached through `ctx.inject`
 * children inside `apply`, so a composition that lacks them still activates the
 * plugin and simply loses the `/git` surface or the shell inspection route.
 */
export const inject = ['systemPrompt', 'tools']

/**
 * Host half entry point.
 *
 * @param {object} ctx - the owning Host context.
 */
export function apply(ctx) {
	// Make sure a human has an obvious file to paste a token into.
	try {
		ensureUserConfig()
	} catch {
		// A read-only install still works; the token can come from the environment.
	}

	// Look the harness message factory up now, so `/git` — which a human types
	// later — finds it ready, and never blocks a command on a module lookup.
	void primeUserMessageFactory()

	ctx.effect(
		() => ctx.systemPrompt.section({ name: 'dsh-github-sync', order: SECTION_ORDER, text: gateText }),
		'dsh-github-sync: gated system prompt section',
	)

	// Track the workspace each agent is working in, and retire an arm once the
	// turn it was armed for has ended.
	ctx.on('agent/pre-step', (payload, next) => {
		const agent = payload?.agent
		if (agent !== undefined && agent !== null) {
			const cwd = cwdOf(agent)
			if (typeof cwd === 'string' && cwd !== '') lastCwd.set(agent, cwd)
			observeStep({ agent, turn: payload?.turn })
		}
		return typeof next === 'function' ? next() : undefined
	})

	// The enforcement half of "never upload by itself".
	ctx.effect(
		() =>
			ctx.tools.guard((execution) => {
				if (execution?.name !== TOOLS.push) return undefined
				if (isPushArmed(execution.agent)) return undefined
				// Two distinct refusals, because the way forward differs: an unarmed
				// turn needs a `/git` at all, while an investigate turn needs the
				// upload spelled out.
				if (isArmed(execution.agent)) {
					return (
						`本轮是【调查轮】：/git 后面没有明确的推送意图，所以不允许上传。\n` +
						'把该查的查完、把要点报告清楚，然后让人类发一条带推送意图的 /git（例如 `/git 推送 dsh-github-sync`）。\n' +
						'现在不要上传，也不要为了"省一轮"而说服自己可以上传。'
					)
				}
				return (
					`${TOOLS.push} 只在人明确要求同步的那一轮里可用。\n` +
					'这个会话没有收到 /git 指令，所以不允许上传任何东西。\n' +
					'如果人确实想上传，请让他在输入框里发一条 /git（可以带要求，例如 `/git 推送表情包插件`）。\n' +
					'不要试图绕过这条限制：不要用 shell 直接跑 git push，也不要假装已经上传成功。'
				)
			}),
		'dsh-github-sync: push guard',
	)

	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.commands.register({
			name: COMMAND,
			description: 'GitHub 同步：按需注入说明（带推送意图才允许上传；平时不会注入任何东西）',
			input: { hint: '[推送 插件名 / 或留空，先只调查]' },
			handler: ({ agent, rawInput }) => {
				const cwd = resolveCwd(agent, loadConfig())
				// The arm is the whole point: it unlocks the gated instructions for
				// exactly the turn this message starts, and records whether that turn
				// may upload. `/git` alone means "go and look", which is often what a
				// human wants — they get the findings first and ask for the upload with
				// a second `/git`.
				arm(agent, rawInput)
				const mode = armMode(agent)
				const banner =
					mode === 'push'
						? `已进入【推送轮】：这一轮允许上传。要求：「${String(rawInput ?? '').trim()}」\n` +
							'先试运行把要推的内容讲清楚，再推；只推要求覆盖到的范围。\n'
						: '已进入【调查轮】：这一轮**只读**，推送工具会拒绝调用。\n' +
							'要真正上传，请再发一条带推送意图的 /git（例如 `/git 推送 dsh-github-sync`）。\n'
				const text = `${banner}\n${statusReport(cwd)}`
				// Build the injected turn through an identified message. A bare
				// `{ role, content, source }` object looks right in memory but has no
				// `id`, and the session journal records `user/message` verbatim: the
				// harness rejects the stored event on replay ("lacks an identified
				// message"), which corrupts load-through-history for the whole session.
				// The harness's own factory is preferred when it resolves; otherwise an
				// equivalent local one supplies the id.
				agent.steer(
					userMessage({
						content: [{ type: 'text', text: overlay(cwd, rawInput) }],
						source: { kind: 'user' },
					}),
				)
				writeStatus({
					version: VERSION,
					armed: true,
					mode,
					cwd,
					command: `/${COMMAND}`,
					plugins: buildPlan({ config: loadConfig(), cwd, only: [] }).entries.map((entry) => ({
						repo: entry.plugin.repo,
						dir: entry.plugin.dir,
						files: entry.manifest.files.length,
						bytes: entry.manifest.totalBytes,
						blockers: entry.blockers,
						skipReason: entry.skipReason,
					})),
				})
				return { kind: 'success', text }
			},
		})
	})

	ctx.tools.register({
		name: TOOLS.status,
		description:
			'报告 GitHub 同步插件的配置状态与当前工作区里发现的所有插件（仓库名、是否可推送、干净副本的文件数与体积）。只读，不联网，不推送。只应在人要求同步时使用。',
		parameters: { type: 'object', properties: {} },
		output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
		async execute(_args, exec) {
			return statusReport(resolveCwd(exec?.agent, loadConfig()))
		},
	})

	ctx.tools.register({
		name: TOOLS.plan,
		description:
			'试运行：列出每个插件真正会被推送的文件、体积，以及被排除的文件和排除原因。不推送、不创建仓库、不写任何远端状态。推送前应当先跑这个并向人汇报。',
		parameters: {
			type: 'object',
			properties: {
				plugins: {
					type: 'array',
					items: { type: 'string' },
					description:
						'要处理哪些目标：写扫描到的插件名（仓库名 / 目录名 / 包名都认），也可以直接写一个【目录路径】（相对或绝对），用来处理扫描结果之外的目录（例如非 DSH 的项目）。省略表示扫描到的全部。'
				},
				verbose: { type: 'boolean', description: '列出每一个被排除的文件，而不只是示例。' }
			}
		},
		output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
		async execute(args, exec) {
			return planReport({
				cwd: resolveCwd(exec?.agent, loadConfig()),
				only: args?.plugins,
				verbose: args?.verbose === true,
			})
		},
	})

	ctx.tools.register({
		name: TOOLS.push,
		description:
			'把插件的干净副本提交并推送到各自的 GitHub 仓库：默认增量提交，历史累积（普通 push，不覆盖远端）；仓库不存在时按配置创建。这是唯一会写 GitHub 的工具，且只在人 /git 触发的那一轮里被允许调用。',
		parameters: {
			type: 'object',
			properties: {
				plugins: {
					type: 'array',
					items: { type: 'string' },
					description:
						'要发布哪些目标：写扫描到的插件名（如 dsh-sticker），也可以直接写一个【目录路径】（相对或绝对），用来发布扫描结果之外的目录（例如非 DSH 的项目）。省略表示扫描到的全部。'
				},
				commonMessage: { type: 'string', description: '覆盖本次提交说明（默认用配置里的模板，含插件名与版本）。' },
				createRepos: { type: 'boolean', description: '仓库不存在时自动创建，默认 true。' },
				verify: { type: 'boolean', description: '推送前用 GitHub API 确认仓库状态，默认 true。' },
				force: {
					type: 'boolean',
					description:
						'强推：用本地镜像的历史替换远端分支，丢弃远端已有提交。仅当远端被别处改过且那些改动确实不需要时使用。默认 false（普通推送，被拒绝就报错）。'
				},
				dryRun: { type: 'boolean', description: '只同步本地镜像并报告将要发生的变更，不提交、不推送。默认 false。' }
			}
		},
		output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
		async execute(args, exec) {
			const config = loadConfig()
			const cwd = resolveCwd(exec?.agent, config)
			const planned = planSync({ config, cwd, only: args?.plugins })
			// A message supplied for this run replaces the configured template
			// outright; it is not remembered beyond this call.
			const effectiveConfig =
				typeof args?.commonMessage === 'string' && args.commonMessage.trim() !== ''
					? { ...config, git: { ...config.git, commitMessageTemplate: args.commonMessage } }
					: config
			const outcome = await execute({
				config: effectiveConfig,
				plan: planned,
				dryRun: args?.dryRun === true,
				createRepos: args?.createRepos !== false,
				verify: args?.verify !== false,
				force: args?.force === true,
			})
			writeStatus({
				version: VERSION,
				armed: false,
				cwd,
				report: pushReport(outcome, args?.dryRun === true),
				results: outcome.results,
			})
			return pushReport(outcome, args?.dryRun === true)
		},
	})

	// A tiny admin surface so a shell can inspect the plugin without a browser.
	ctx.inject(['connection'], (connectionCtx) => {
		connectionCtx.effect(
			() =>
				connectionCtx.connection.fetch.register({
					path: '/api/dsh-github-sync/status',
					methods: ['GET'],
					requestBody: 'buffered',
					fetch: () => {
						const config = loadConfig()
						const cwd = resolveCwd(undefined, config)
						return {
							status: 200,
							headers: { 'content-type': 'application/json; charset=utf-8' },
							body: JSON.stringify(
								{
									version: VERSION,
									owner: config.github.owner,
									tokenPresent: typeof config.github.token === 'string' && config.github.token !== '',
									tokenSource: config.github.tokenSource,
									userConfig: USER_CONFIG,
									git: resolveGit(config.git.executable),
									roots: scanRoots(config, cwd),
									report: statusReport(cwd),
								},
								null,
								2,
							),
						}
					},
				}),
			'dsh-github-sync: admin status route',
		)
	})
}

export { TOOLS, USER_CONFIG, writeUserToken, clearUserToken }
