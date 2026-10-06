/**
 * The `/git` gate.
 *
 * Requirement, verbatim: instructions must not be injected during ordinary
 * conversation — only when the human types `/git` — and the plugin must never
 * upload anything on its own.
 *
 * Both halves are enforced here rather than requested in prose:
 *
 *  - **Injection.** The system-prompt section returns an empty string unless the
 *    calling agent is armed. `/git` arms exactly one agent, for exactly one turn.
 *  - **Action.** The push tool is registered permanently but carries a monotonic
 *    tool guard that denies every call from an unarmed agent. A model that
 *    forgets the rule, or invents the intent on its own, gets a refusal instead
 *    of a push.
 *
 * The arm is dropped at the first step of the turn it was armed for, so the
 * section is present while that turn's request is assembled and absent
 * afterwards. The guard deliberately keeps its own copy of the turn number: the
 * model may call the tool on any step of that turn, including steps after the
 * first one cleared the prompt gate.
 */

import { loadConfig } from './config.js'
import { scanRoots } from './sync.js'

/** Tool names this plugin owns. */
export const TOOLS = {
	status: 'github_sync_status',
	plan: 'github_sync_plan',
	push: 'github_sync_push',
}

/** How long an unused `/git` arm stays valid, in milliseconds. */
const ARM_TTL_MS = 30 * 60 * 1000

/**
 * Words that ask for an upload.
 *
 * `/git` on its own is an invitation to look, not to publish: exploring what
 * would ship is useful on its own, and a human who has just been shown the plan
 * can ask for the upload in a second `/git`. Requiring an explicit verb keeps the
 * original rule intact — nothing is ever uploaded on the tool's own initiative —
 * without making every push cost two turns.
 */
const PUSH_INTENT = /(推送|上传|推上去|推到|推一下|发布|同步|push|upload|publish|sync)/i

/** Words that hold an upload back even when the same sentence asks for one. */
const HOLD_BACK = /(先别|别推送|不要推送|暂不|先不|别上传|不要上传|先看看|只看|别推|don't push|do not push|hold off)/i

/**
 * Whether a `/git` request asks for an upload, rather than only a look.
 *
 * @param {string | undefined} request - the human's text after `/git`.
 * @returns {boolean} true when the request carries an explicit upload intent.
 */
export function wantsPush(request) {
	const text = String(request ?? '')
	return PUSH_INTENT.test(text) && !HOLD_BACK.test(text)
}

/**
 * @typedef {object} Arm
 * @property {number} at - when the arm was created.
 * @property {number | undefined} turn - the turn the arm is currently grazing.
 * @property {number | undefined} origin - the turn the instructions belong to.
 * @property {string} request - the human's text after `/git`, possibly empty.
 * @property {'push' | 'investigate'} mode - whether this turn may upload.
 */

/** @type {WeakMap<object, Arm>} */
const arms = new WeakMap()

/**
 * Arm one agent for one turn.
 *
 * @param {object} agent - the receiving agent.
 * @param {string} request - the human's text after `/git`.
 */
export function arm(agent, request) {
	const text = String(request ?? '')
	arms.set(agent, {
		at: Date.now(),
		turn: undefined,
		origin: undefined,
		request: text,
		mode: wantsPush(text) ? 'push' : 'investigate',
	})
}

/**
 * Whether an agent may still use the push tool.
 *
 * An arm survives the whole turn it was created for — every step of it — and is
 * dropped at the first step of the next turn. That is deliberately wider than
 * the prompt gate below: the instructions are shown once, while the permission
 * to act lasts as long as the turn they belong to.
 *
 * @param {object} agent - the agent attempting the call.
 * @returns {boolean} true when the agent was armed for a turn that has not ended.
 */
export function isArmed(agent) {
	const current = agent === undefined || agent === null ? undefined : arms.get(agent)
	if (current === undefined) return false
	if (Date.now() - current.at >= ARM_TTL_MS) {
		arms.delete(agent)
		return false
	}
	return true
}

/**
 * Whether this armed turn may actually upload.
 *
 * Investigate turns are armed too — they may read the configuration, the plan,
 * and the file lists — but the push tool refuses, and says how to proceed.
 *
 * @param {object} agent - the agent attempting the call.
 * @returns {boolean} true when the human's request carried an upload intent.
 */
export function isPushArmed(agent) {
	if (!isArmed(agent)) return false
	return arms.get(agent)?.mode === 'push'
}

/**
 * The mode of the current arm, for the instructions and for diagnostics.
 *
 * @param {object} agent - the armed agent.
 * @returns {'push' | 'investigate' | undefined} the mode, when armed.
 */
export function armMode(agent) {
	return isArmed(agent) ? arms.get(agent)?.mode : undefined
}

/**
 * Observe one step boundary.
 *
 * The first accepted step after `/git` is where the armed turn is identified:
 * that step's turn number is recorded and becomes the turn whose instructions
 * are injected. Assembly for that same turn happens after this listener, so the
 * section is present exactly for it. The following turn's first step drops the
 * arm, before that turn is assembled.
 *
 * Nothing here is a side effect on the session — an arm lives only in this
 * process's memory, so restarting the harness can never leave instructions
 * injected in a later session.
 *
 * @param {object} payload - the `agent/pre-step` payload.
 * @param {{ agent?: object, turn?: number }} payload - the receiving agent and its turn number.
 */
export function observeStep({ agent, turn }) {
	if (agent === undefined || agent === null) return
	const current = arms.get(agent)
	if (current === undefined) return
	if (Date.now() - current.at >= ARM_TTL_MS) {
		arms.delete(agent)
		return
	}
	const observed = typeof turn === 'number' ? turn : -1
	if (current.origin === undefined) {
		// This is the turn `/git` was sent for; it keeps both the instructions and
		// the push permission.
		current.origin = observed
		current.turn = observed
		return
	}
	if (observed > current.origin) {
		arms.delete(agent)
		return
	}
	current.turn = observed
}

/**
 * Whether the instructions belong to the turn currently being assembled.
 *
 * @param {Arm | undefined} current - the agent's arm, when it has one.
 * @returns {boolean} true when the gated section should render.
 */
function gateOpen(current) {
	if (current === undefined) return false
	if (current.origin === undefined) return true
	return current.origin === current.turn
}

/**
 * The session's working directory, read from the session header the harness
 * itself uses for its `cwd` prompt variable.
 *
 * @param {object | undefined} agent - the calling agent.
 * @returns {string | undefined} the workspace path, when known.
 */
export function cwdOf(agent) {
	const cwd = agent?.session?.header?.cwd
	return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * The plugin list the gated prompt shows the model, so it can answer questions
 * about what is available without spending a tool call.
 *
 * @param {object | undefined} agent - the calling agent.
 * @returns {{ names: string, roots: string, owner: string }} a compact inventory.
 */
function inventory(agent) {
	const config = loadConfig()
	const roots = scanRoots(config, cwdOf(agent))
	return {
		names: roots.join('、'),
		owner: config.github.owner === '' ? '（未配置）' : config.github.owner,
	}
}

/**
 * Text of the gated section; a non-empty value only while an agent is armed.
 *
 * @param {object} context - the assembly context.
 * @param {object} [context.agent] - the agent the request is being assembled for.
 * @returns {string} the instructions, or an empty string when not armed.
 */
export function gateText(context) {
	const agent = context?.agent
	if (agent === undefined || agent === null) return ''
	if (!gateOpen(arms.get(agent))) return ''
	const info = inventory(agent)
	const current = arms.get(agent)
	const phase =
		current?.mode === 'push'
			? [
					'## This turn: an upload is authorized',
					'',
					`The human asked for an upload: "${current.request.trim()}". Read the plan first and show its substance; then upload only what the request covers.`,
				]
			: [
					'## This turn: investigate only — the push tool will refuse',
					'',
					current !== undefined && current.request.trim() !== ''
						? `The human wrote "${current.request.trim()}", which does not ask for an upload, so this turn is for finding out.`
						: 'The human sent `/git` with no further text, so this turn is for finding out.',
					'',
					`Look everything up: \`${TOOLS.status}\`, \`${TOOLS.plan}\` (with \`verbose\` when the exclusion list matters), and the plugin directories themselves. Then report what would be published, what would not, and anything that needs a decision.`,
					'',
					`**To upload, the human sends \`/git 推送 …\` in their next message.** Do not treat this turn as a request to upload, and do not ask for a second confirmation you could have avoided: if the answer is ready, say what you found and end with the one line they should send.`,
				]
	return [
		'# GitHub sync — explicitly requested by the human',
		'',
		'The human typed `/git`, which is the only way this capability becomes available. It lasts for this one turn.',
		'',
		...phase,
		'',
		'## The rule that matters',
		'',
		'- **Never upload on your own initiative.** Only a turn whose request carried an upload intent may push; every other turn is read-only, and the push tool refuses.',
		'- **A new session cannot upload.** Without `/git` in that session, the push tool refuses every call. If a human asks you to upload and the tool refuses, tell them to send `/git 推送 …` — do not work around it.',
		'- **Treat the human\'s request as the scope.** "Push the sticker plugin" means that plugin. "Push everything" means everything. When the request is ambiguous about *which* plugins or *which* repository, ask before pushing.',
		'- **Read before you write.** `github_sync_plan` is a dry run: it reports exactly which files would ship, how many bytes, and what was excluded and why. Run it, show the human the substance, and only then push.',
		'- **Report what actually happened.** Quote real file counts, commit ids, and repository URLs from the tool results. If a plugin failed, say so and say why; never describe a failure as a success.',
		'',
		'## 自适应：先判断这是什么，再套对应的规则',
		'',
		'不是所有目录都是 DSH 插件，所以不要一律套同一条规则。**工具已经把判定结果报给你了**：每个条目标注它是不是 DSH 插件（指纹 = `package.json` 的 `dsh.bundle` / `dsh.client`，或关键词含 `dsh`；也包括 `cordis.patch.yml`），以及它的 `kind`。据此分别处理：',
		'',
		'| 判定 | 命名 | topic | 协议 |',
		'|---|---|---|---|',
		'| DSH 插件 | 文件夹**建议**带 `dsh-` 前缀（仓库名默认取文件夹名）。不合规默认只**警告**，除非配置 `naming: "block"` | 默认打 `dsh-plugin` | 缺失且配了 `github.license` 才生成 |',
		'| 普通项目（显式 `targets` 里声明的目录） | **不适用**，不要建议改名 | 默认不打 | 缺失且该 target 配了 `license` 才生成 |',
		'',
		'你**不需要**自己去猜指纹——报给你的分类就是判定结果。但你需要**自己判断该怎么做**：不合规要不要改名（改名会打断 profile 的 `link:` 依赖）、要不要加协议、要不要打 topic，都应当在报告里给出你的建议和代价，让人来定。',
		'',
		'注意：`dsh-` 前缀只是**建议的约定**，不是"必须"。真正的硬性要求只有一条：**不要静默替人改名**，也不要静默替人决定协议。',
		'',
		'## 范围不等于扫描结果',
		'',
		'扫描器只负责列出"工作区里看起来像 DSH 插件的东西"，它**不是**发布权限的来源——发布权限来自人类的要求。所以：',
		'',
		`- \`${TOOLS.plan}\` 与 \`${TOOLS.push}\` 的 \`plugins\` 参数**也接受目录路径**（相对或绝对）。扫描没认出来的目录照样可以发布，只要路径存在；会话自己就在某个项目的开发环境里时，直接给出那个目录即可。`,
		'- 目标是不是 DSH 插件由指纹判定并报给你；不是的话就不套 `dsh-` 前缀与 `dsh-plugin` topic，其余流程完全一样（干净副本、密钥扫描、单文件上限、提交、普通推送）。',
		'- 报告义务不因目标来源而改变：**哪些文件会发布、多少字节、排除了什么**，一律照报。',
		'',
		'唯一会拒绝的目标是与 DSH 自己的目录（`~/.dsh`，存着 token、会话记录、发布镜像）相重叠的路径——那是为了不让密钥被推上去。',
		'',
		'## Tools',
		'',
		`- \`${TOOLS.status}\` — configuration, token presence, git availability, and every discovered plugin. No arguments.`,
		`- \`${TOOLS.plan}\` — dry run. Optional \`plugins\` filter and \`verbose\` for the full excluded-file list.`,
		`- \`${TOOLS.push}\` — the real upload. Optional \`plugins\` filter, \`commonMessage\` for one commit subject, \`createRepos\` to allow creating missing repositories, \`verify\` to check each repository first, \`force\` to replace the remote branch with a single fresh snapshot instead of committing on top of it.`,
		'',
		'## 发布约定（插件会真的检查，不只是提醒）',
		'',
		'- **有改动的发布要升 `package.json` 的 `version`。** 文件变了而版本没变，插件会在结果里警告。',
		'- **README 末尾保留「版本历史」小节，按版本倒序**，每条含版本号与年月日时分：',
		'',
		'  ```markdown',
		'  ## 📌 版本历史',
		'',
		'  ### v0.2.0（2026-10-06 11:05）',
		'  - 这次改了什么（要点，不是堆文件名）',
		'',
		'  ### v0.1.0（2026-10-05 16:16）',
		'  - 首次发布',
		'  ```',
		'',
		'- 升了版本、但 README 里搜不到新版本号，插件也会警告。',
		'- 提交说明用中文，说清这次改了什么；模板里带版本号。',
		'',
		'## Environment',
		'',
		`- GitHub account from configuration: ${info.owner}`,
		`- Scan roots in this session: ${info.names}`,
		'- Publish model: one plugin becomes one repository, committed incrementally on top of the remote tip and pushed normally, so history accumulates. `force` replaces the branch with a single fresh snapshot when a commit must be gone.',
		'- Commit content always equals the clean copy exactly: files dropped from the manifest are deleted in the next commit, including ones an earlier publish had committed.',
		'- The clean copy excludes dependency trees, build output, caches, and runtime state (`*.status.json`, `*.local.json`, `.env`). Local `cache/`, `images/`-style data directories are judged per plugin — inspect the plan and say what is going where.',
		'- One file may not exceed `maxFileBytes` (default 100 MiB, GitHub\'s own block limit; over 50 MiB warns). Exceeding it is a blocker, so a large asset is never dropped silently.',
		'- Commits are signed by the account the token belongs to, via its noreply address, unless `git.userName` / `git.userEmail` say otherwise.',
		'',
	].join('\n')
}

