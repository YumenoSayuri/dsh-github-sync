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
 * @typedef {object} Arm
 * @property {number} at - when the arm was created.
 * @property {number} at - when the arm was created.
 * @property {number | undefined} turn - the turn the arm is currently grazing.
 * @property {number | undefined} origin - the turn the instructions belong to.
 * @property {string} request - the human's text after `/git`, possibly empty.
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
	arms.set(agent, { at: Date.now(), turn: undefined, origin: undefined, request: String(request ?? '') })
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
	return [
		'# GitHub sync — explicitly requested by the human',
		'',
		'The human typed `/git`, which is the only way this capability becomes available. It lasts for this one turn.',
		'',
		'## The rule that matters',
		'',
		'- **Never upload on your own initiative.** One session of `/git` authorizes nothing beyond what the human asked for in this turn.',
		'- **A new session cannot upload.** Without `/git` in that session, the push tool refuses every call. If a human asks you to upload and the tool refuses, tell them to send `/git` first — do not work around it.',
		'- **Treat the human\'s request as the scope.** "Push the sticker plugin" means that plugin. "Push everything" means everything. When the request is ambiguous about *which* plugins or *which* repository, ask before pushing.',
		'- **Read before you write.** `github_sync_plan` is a dry run: it reports exactly which files would ship, how many bytes, and what was excluded and why. Run it, show the human the substance, and only then push.',
		'- **Report what actually happened.** Quote real file counts, commit ids, and repository URLs from the tool results. If a plugin failed, say so and say why; never describe a failure as a success.',
		'',
		'## Tools',
		'',
		`- \`${TOOLS.status}\` — configuration, token presence, git availability, and every discovered plugin. No arguments.`,
		`- \`${TOOLS.plan}\` — dry run. Optional \`plugins\` filter and \`verbose\` for the full excluded-file list.`,
		`- \`${TOOLS.push}\` — the real upload. Optional \`plugins\` filter, \`commonMessage\` for one commit subject, \`createRepos\` to allow creating missing repositories, \`verify\` to check each repository first.`,
		'',
		'## Environment',
		'',
		`- GitHub account from configuration: ${info.owner}`,
		`- Scan roots in this session: ${info.names}`,
		'- Publish model: one plugin becomes one repository, force-pushed as a single fresh snapshot commit. The repository is a publication of the clean copy, not a merge target; there is no history to preserve on the remote.',
		'- The clean copy excludes dependency trees, build output, caches, and runtime state (`*.status.json`, `*.local.json`, `.env`). Local `cache/`, `images/`-style data directories are judged per plugin — inspect the plan and say what is going where.',
		'',
	].join('\n')
}

export default gateText