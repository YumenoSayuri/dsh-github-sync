/**
 * GitHub REST calls.
 *
 * Only two things need the API: checking whether a repository exists, and
 * creating it when it does not. Everything else — the actual upload — is git.
 * The token rides in an Authorization header, and the request URL carries no
 * credential at all.
 */

import { maskSecret } from './git.js'

/** How long any single GitHub API call may take. */
const API_TIMEOUT_MS = 30_000

/**
 * Call the GitHub API once.
 *
 * @param {object} options - request inputs.
 * @param {string} options.apiBase - API base URL, no trailing slash.
 * @param {string} options.token - GitHub token.
 * @param {string} options.path - API path beginning with `/`.
 * @param {string} [options.method] - HTTP method.
 * @param {Record<string, unknown>} [options.body] - JSON request body.
 * @param {string} [options.accept] - Accept header.
 * @returns {Promise<{ status: number, json: any, text: string }>} the decoded response.
 */
async function api({ apiBase, token, path, method = 'GET', body, accept = 'application/vnd.github+json' }) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
	let response
	try {
		response = await fetch(`${apiBase}${path}`, {
			method,
			signal: controller.signal,
			headers: {
				accept,
				authorization: `Bearer ${token}`,
				'x-github-api-version': '2022-11-28',
				'user-agent': 'dsh-github-sync',
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	} catch (error) {
		const reason = error.name === 'AbortError' ? `超过 ${API_TIMEOUT_MS / 1000} 秒` : error.message
		throw new Error(`访问 GitHub API 失败（${apiBase}${path}）：${maskSecret(reason, token)}`)
	} finally {
		clearTimeout(timer)
	}

	const text = await response.text()
	let json
	try {
		json = text === '' ? undefined : JSON.parse(text)
	} catch {
		json = undefined
	}
	return { status: response.status, json, text }
}

/**
 * Turn a failed API response into an actionable error.
 *
 * @param {object} options - failure inputs.
 * @param {string} options.action - what was being attempted, in Chinese.
 * @param {{ status: number, json: any, text: string }} options.response - the response.
 * @param {string} options.token - the token, masked out of any echo.
 * @returns {Error} the error to throw.
 */
function failure({ action, response, token }) {
	const message = response.json?.message
	const detail = typeof message === 'string' && message !== '' ? message : maskSecret(response.text.slice(0, 400), token)
	const hints = []
	if (response.status === 401) hints.push('token 无效或已过期 — 重新生成一个再写进配置文件。')
	if (response.status === 403) hints.push('token 权限不足 — fine-grained token 需要 Administration: Read and write（只用于建仓库）与 Contents: Read and write。')
	if (response.status === 404) hints.push('账号或仓库不存在，或 token 看不到它。')
	if (response.status === 422) hints.push('请求被拒绝 — 常见原因是仓库名已被占用或名字不合法。')
	return new Error(`${action} 失败：HTTP ${response.status}${detail === '' ? '' : ` — ${detail}`}${hints.length === 0 ? '' : `\n${hints.join('\n')}`}`)
}

/**
 * Read the identity the token belongs to.
 *
 * @param {object} options - request inputs.
 * @param {string} options.apiBase - API base URL.
 * @param {string} options.token - GitHub token.
 * @returns {Promise<{ login: string, type: string, name?: string }>} the authenticated account.
 */
export async function whoAmI({ apiBase, token }) {
	const response = await api({ apiBase, token, path: '/user' })
	if (response.status !== 200) throw failure({ action: '读取 GitHub 账号', response, token })
	const login = response.json?.login
	if (typeof login !== 'string' || login === '') throw new Error('GitHub 没有返回已登录账号，token 可能不是有效凭据。')
	return { login, type: String(response.json?.type ?? 'User'), name: response.json?.name ?? undefined }
}

/**
 * Whether a repository exists and is visible to this token.
 *
 * @param {object} options - request inputs.
 * @param {string} options.apiBase - API base URL.
 * @param {string} options.token - GitHub token.
 * @param {string} options.repository - `owner/name`.
 * @returns {Promise<{ exists: boolean, private?: boolean, defaultBranch?: string, htmlUrl?: string }>} the probe result.
 */
export async function describeRepository({ apiBase, token, repository }) {
	const response = await api({ apiBase, token, path: `/repos/${repository}` })
	if (response.status === 404) return { exists: false }
	if (response.status !== 200) throw failure({ action: `读取仓库 ${repository}`, response, token })
	return {
		exists: true,
		private: response.json?.private === true,
		defaultBranch: typeof response.json?.default_branch === 'string' ? response.json.default_branch : undefined,
		htmlUrl: typeof response.json?.html_url === 'string' ? response.json.html_url : undefined,
	}
}

/**
 * Create a repository under the authenticated account or a named organization.
 *
 * A 422 whose message says the name already exists is treated as success: the
 * goal is "a repository with this name is there", and it is.
 *
 * @param {object} options - request inputs.
 * @param {string} options.apiBase - API base URL.
 * @param {string} options.token - GitHub token.
 * @param {string} options.owner - account or organization that will own it.
 * @param {string} options.accountType - `user` or `org`.
 * @param {string} options.name - repository name.
 * @param {string} options.visibility - `private` or `public`.
 * @param {string} [options.description] - repository description.
 * @returns {Promise<{ created: boolean, alreadyExisted: boolean, htmlUrl?: string }>} the outcome.
 */
export async function createRepository({ apiBase, token, owner, accountType, name, visibility, description }) {
	const isOrg = accountType === 'org'
	const path = isOrg ? `/orgs/${owner}/repos` : '/user/repos'
	const response = await api({
		apiBase,
		token,
		path,
		method: 'POST',
		body: {
			name,
			private: visibility !== 'public',
			description: description === undefined || description === '' ? undefined : description,
			auto_init: false,
			has_issues: true,
			has_wiki: false,
			has_projects: false,
		},
	})

	if (response.status === 201) {
		return { created: true, alreadyExisted: false, htmlUrl: response.json?.html_url }
	}
	if (response.status === 422) {
		const message = String(response.json?.message ?? '')
		const errors = Array.isArray(response.json?.errors) ? response.json.errors : []
		const already = /already exists/i.test(message) || errors.some((item) => /already exists/i.test(String(item?.message ?? '')))
		if (already) return { created: false, alreadyExisted: true }
	}
	throw failure({ action: `创建仓库 ${owner}/${name}`, response, token })
}

/**
 * Replace a repository's topics.
 *
 * This is how a plugin announces itself to the community: GitHub renders one
 * browsable page per topic, so every DSH plugin carrying `dsh-plugin` lands on
 * the same list — https://github.com/topics/dsh-plugin — without anyone running
 * a registry. The endpoint replaces all topics, so the list given here is the
 * complete desired state.
 *
 * @param {object} options - request inputs.
 * @param {string} options.apiBase - API base URL.
 * @param {string} options.token - GitHub token.
 * @param {string} options.repository - `owner/name`.
 * @param {string[]} options.topics - the complete topic list.
 * @returns {Promise<{ applied: boolean, topics: string[], skipped?: string }>} the outcome.
 */
export async function setTopics({ apiBase, token, repository, topics }) {
	const names = Array.isArray(topics) ? topics.filter((topic) => typeof topic === 'string' && topic !== '') : []
	if (names.length === 0) {
		// An empty list is a valid choice: the caller asked for no topics, so
		// nothing is changed rather than clearing whatever is already on the repo.
		return { applied: false, topics: [], skipped: '没有配置任何 topic，跳过' }
	}
	const response = await api({
		apiBase,
		token,
		path: `/repos/${repository}/topics`,
		method: 'PUT',
		body: { names },
		accept: 'application/vnd.github+json',
	})
	if (response.status !== 200) throw failure({ action: `设置 ${repository} 的 topics`, response, token })
	const applied = Array.isArray(response.json?.names) ? response.json.names.map(String) : names
	return { applied: true, topics: applied }
}

export default createRepository