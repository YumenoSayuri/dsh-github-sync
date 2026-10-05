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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureUserConfig, loadConfig, USER_CONFIG, writeUserToken, clearUserToken } from './internal/config.js'
import { humanBytes, plan as buildPlan, execute, plan as planSync, resolveGit, scanRoots, writeStatus } from './internal/sync.js'
import { arm, cwdOf, gateText, isArmed, observeStep, TOOLS } from './internal/prompt.js'

const HERE = dirname(fileURLToPath(import.meta.url))

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
	lines.push(`  推送方式      每个插件一个独立仓库，强制推成单次快照提交`)
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
			lines.push(
				`    [${state}] ${plugin.repo}  ←  ${plugin.relativeDir === '.' ? '.' : plugin.relativeDir}` +
					`  (${plugin.name}@${plugin.version}, ${manifest.mode === 'allowlist' ? '白名单' : '默认排除'}, ` +
					`${manifest.files.length} 个文件 / ${humanBytes(manifest.totalBytes)})`,
			)
			for (const blocker of entry.blockers) lines.push(`        ! ${blocker}`)
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
		lines.push(`  目录        ${plugin.dir}`)
		lines.push(`  仓库        ${entry.repository ?? '（未配置 github.owner）'}  [${entry.visibility}]`)
		lines.push(`  仓库 topics ${entry.topics.length === 0 ? '（不打标签）' : entry.topics.join('、')}`)
		lines.push(`  模式        ${manifest.mode === 'allowlist' ? 'include 白名单' : '默认排除 + .gitignore'}`)
		lines.push(`  会推送      ${manifest.files.length} 个文件 / ${humanBytes(manifest.totalBytes)}`)
		lines.push(`  会排除      ${manifest.excluded.length} 项`)
		if (manifest.secrets.length > 0) {
			lines.push(`  ⚠ 检出密钥  ${manifest.secrets.length} 个文件被拦下，不会上传：`)
			for (const item of manifest.secrets) lines.push(`      ${item.path}  —  ${item.kind}`)
		}
		if (entry.skipReason !== undefined) lines.push(`  状态        跳过 — ${entry.skipReason}`)
		for (const blocker of entry.blockers) lines.push(`  ! ${blocker}`)

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
	lines.push(dryRun ? 'GitHub 同步 — 试运行结果（没有推送）' : 'GitHub 同步 — 推送结果')
	if (outcome.identity !== undefined) lines.push(`  身份        ${outcome.identity.login}（${outcome.identity.type}）`)
	for (const warning of outcome.warnings) lines.push(`  ! ${warning}`)
	lines.push('')
	for (const result of outcome.results) {
		const mark = result.outcome === 'failed' ? '✗' : result.outcome === 'skipped' ? '-' : '✓'
		lines.push(`${mark} ${result.plugin}  [${result.outcome}]  ${result.files} 个文件 / ${humanBytes(result.bytes)}`)
		for (const detail of result.detail) lines.push(`    ${detail}`)
	}
	const failed = outcome.results.filter((result) => result.outcome === 'failed').length
	lines.push('')
	lines.push(`合计：${outcome.results.length} 个插件，成功 ${outcome.results.length - failed}，失败 ${failed}。`)
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
	const lines = []
	lines.push('`/git` 已触发 GitHub 同步。')
	lines.push('')
	if (request.trim() === '') {
		lines.push('你没有在 /git 后面写具体要求，所以把下面这份现状当作待确认的意图，先问清楚再动手：')
	} else {
		lines.push(`你的要求是：${request.trim()}`)
		lines.push('')
		lines.push('先按上面这句确认范围，再决定推送哪些插件：')
	}
	lines.push('')
	lines.push(`- 可推送插件（${ready.length}/${planned.entries.length}）：${planned.entries.map((entry) => `${entry.plugin.repo}${entry.blockers.length > 0 || entry.skipReason !== undefined ? '（不可推送）' : ''}`).join('、') || '（无）'}`)
	lines.push(`- GitHub 账号：${config.github.owner === '' ? '未配置，推不了' : config.github.owner}`)
	lines.push(`- Token：${typeof config.github.token === 'string' && config.github.token !== '' ? '已有' : '缺失'}`)
	lines.push('')
	lines.push('按当前会话里的规则做：先 `github_sync_plan` 试运行并把要点讲清楚，得到确认后再 `github_sync_push`；本插件的推送工具只在这一轮里可用。')
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
				if (isArmed(execution.agent)) return undefined
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
			description: 'GitHub 同步：按需注入说明并允许推送插件（平时不会注入任何东西）',
			input: { hint: '[要推送哪个插件 / 或留空让我先问]' },
			handler: ({ agent, rawInput }) => {
				const cwd = resolveCwd(agent, loadConfig())
				// The arm is the whole point: it unlocks the gated instructions and the
				// push tool for exactly the turn this message starts.
				arm(agent, rawInput)
				const text = statusReport(cwd)
				agent.steer({
					role: 'user',
					content: [{ type: 'text', text: overlay(cwd, rawInput) }],
					source: { kind: 'user' },
				})
				writeStatus({
					version: VERSION,
					armed: true,
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
					description: '只处理这些插件（仓库名 / 目录名 / 包名都认）。省略表示全部。'
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
			'把插件上传到各自的 GitHub 仓库：为每个插件建独立仓库（不存在时按配置创建），并把干净副本强制推成一次快照提交。这是唯一会写 GitHub 的工具，且只在人 /git 触发的那一轮里被允许调用。',
		parameters: {
			type: 'object',
			properties: {
				plugins: {
					type: 'array',
					items: { type: 'string' },
					description: '只推送这些插件。省略表示推送全部可推送的插件。'
				},
				commonMessage: { type: 'string', description: '覆盖提交说明模板（默认含插件名、版本、时间）。' },
				createRepos: { type: 'boolean', description: '仓库不存在时自动创建，默认 true。' },
				verify: { type: 'boolean', description: '推送前用 GitHub API 确认仓库状态，默认 true。' },
				dryRun: { type: 'boolean', description: '只做本地提交、不推送，用来验证打包是否正常。默认 false。' }
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
