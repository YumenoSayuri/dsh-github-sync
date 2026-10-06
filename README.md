# GitHub 同步插件 (`@local/dsh-github-sync`)

专为 DSH 插件开发者设计：把本地工作区里的插件**作为干净副本**推送到各自独立的 GitHub 仓库，并给新仓库打上 `dsh-plugin` topic。

---

## 核心设计与特性

1. **绝对防误触 / 零日常污染（按需触发）**：
   - **平时不注入任何系统提示词**，完全不消耗日常聊天的 Context 和 token。
   - **插件自身绝不自动上传**，也没有任何后台轮询/保存即上传的钩子。
   - 必须由人类在聊天框显式输入 `/git`（例如 `/git` 或 `/git 推送 sticker 插件`）才会激活当轮的说明与工具权限。
   - **强同步守卫（Tool Guard）**：即使 AI 产生了幻觉试图私自调用 `github_sync_push`，若该轮未收到人类 `/git` 授权，调用会被底层同步拦截拒绝。这条限制用实测验证过：未授权的会话里调用会直接收到拒绝理由。

2. **凭据安全（Token 只存一次，且不可能被推上去）**：
   - GitHub Token 只放在机器级用户目录：`%USERPROFILE%\.dsh\github-sync\config.json`。
   - 该文件不在任何工作区/仓库里，绝不进 git，所有 DSH 会话和 profile 自动复用。
   - **不要把 token 写进插件目录里的 `sync.config.json`**：那个文件在干净副本范围内，等于把密钥放到待上传目录。若真写了，插件会：① 在状态里告警；② 由**密钥扫描**把含密钥的文件从干净副本中剔除并列为阻断项，绝不推上去。
   - 推送时通过临时生成的**凭据助手（Credential Helper）**把 token 交给 git，命令行参数、remote URL、报错信息里都不会出现明文（报错统一脱敏）。
   - 密钥扫描覆盖：GitHub 经典/细粒度 token、Slack token、AWS Access Key、`sk-` 风格密钥、Google API key、私钥文件头。文档里的占位符（如 `ghp_xxxx`）不会误报。

3. **干净副本（Clean Copy）**：
   - 自动排除运行时与非必要文件：`.git/`、`node_modules/`、`cache/`、`dist/`、`build/`、`coverage/`、`*.status.json`、`*.local.json`、`.env*`、`_scratch/`、`_research/` 等。
   - 符号链接不跟随（避免把仓库外的内容复制进去）。
   - 插件若自带 `.gitignore` 或配置了 `include` 白名单，一律尊重（`include` 白名单也不会绕过密钥扫描）。
   - **每次提交的内容都精确等于干净副本**：发布时会先把镜像工作树清空、再按干净副本写入，因此不只是"只加不删"——先前误提交过的缓存/状态文件，会在下一次提交里作为删除出现在**历史**中（可追溯，不是静默改写）。

4. **标准 git 流程：增量提交、真实历史、普通推送**：
   - 每个插件一个**常驻本地镜像仓库**（clone），存放在 `%USERPROFILE%\.dsh\github-sync\mirrors\<仓库名>`，`.git` 保留 → 历史正常累积。
   - 每次发布 = 把干净副本同步进镜像 → **一个真实提交** → **普通 `git push`（不强制）**。`git log` / `git blame` / `git revert` 全部可用。
   - 推送前先 `fetch` 并以**远端 tip 为基准**提交，所以别人在 GitHub 网页上的修改、或另一台克隆推上来的提交，都会被保留，你的提交落在它们上面（而不是把它们抹掉）。
   - **无变更不提交**：干净副本与远端一致时不产生空提交，结果为 `unchanged`。
   - **推送被拒绝就如实报错**，绝不偷偷强推。拒绝信息会区分「远端有本地没有的提交（竞态，重跑即可）」和「分支受保护（要去改仓库设置）」两种情况。
   - **`force` 保留为显式选项**（原本的快照语义）：生成一个孤立根提交（干净副本）并强推，**远端历史被替换**。用途是"这个提交必须从历史里消失"（比如误提交了密钥），不是日常发布。
   - 镜像坏了/想重新对齐远端：删掉该镜像目录即可，下次会自动重建。

5. **开源协议（按需生成，不替你选）**：
   - 插件目录里已有 `LICENSE` / `COPYING` 等文件时**直接沿用**。
   - 缺失且配置了 `github.license` 时，从 GitHub 官方接口 `GET /licenses/{key}` 取**权威正文**（不自己编），替换版权行后作为 `LICENSE` 写进**同一个提交**。正文会缓存到 `licensesDir`，之后不再依赖网络。
   - 未配置时**只告警**：选协议是法律决定，不该由工具替你定。
   - 占位符按各协议实际形态替换（MIT/ISC/BSD 用 `[year]`/`[fullname]`，Apache-2.0 用 `[yyyy]`，MPL-2.0 无占位符则原样保留）。

6. **命名约定：`dsh-` 前缀（文件夹即仓库名）**：
   - **DSH 插件的文件夹本身必须带 `dsh-` 前缀**，仓库名默认就等于那个文件夹名（文件夹 = 插件在磁盘上的身份）。所以 `dsh-sticker/` → 仓库 `dsh-sticker`，`dsh-github-sync/` → 仓库 `dsh-github-sync`。
   - 文件夹不合规时**不会被静默改名**，而是列为**阻断项**并给出确切的改名建议（例如 `nova-preset` → `dsh-nova-preset`），避免你推完才发现仓库名被换掉了。
   - 包名（`package.json` 的 `name`）与文件夹名不一致不影响判定：规则只认文件夹。
   - 有意的例外：在 `sync.config.json` 里为该插件显式写 `plugins.<目录名>.repo`，此时按你的显式值走，不再判定合规。
   - 注意：改文件夹名会打断 profile 里按路径建立的 `link:` 依赖，改完需要在插件管理里重新安装/链接。

7. **联合投稿（GitHub topics）**：
   - 每个插件仓库默认打上 `dsh-plugin` topic，全部汇总到 https://github.com/topics/dsh-plugin —— 这就是"联合投稿"的落地方式，不需要任何中心化注册表。
   - 改 `github.topics` 可加自己的标签；写 `[]` 表示不打标签；单个插件可用 `plugins.<名>.topics` 覆盖。
   - **topics 页只收录公开仓库**：私有仓库打了标签也不会出现在那里。要真正"被联合投稿收录"，仓库得是 `public`。
   - topics 在代码推送成功之后才设置，所以即使打标签失败也不会影响代码上传。

---

## 快速配置使用

### 1. 填写 GitHub 账号与 Token（只需一次）

编辑用户配置文件（不在任何仓库里）：
`%USERPROFILE%\.dsh\github-sync\config.json`
（插件首次加载会自动生成带注释的模板，所以通常直接打开改就行。）

```json
{
  "github": {
    "owner": "你的GitHub用户名",
    "token": "ghp_xxxx 或 github_pat_xxxx",
    "topics": ["dsh-plugin"],
    "license": "MIT",
    "copyright": "你的署名或组织名"
  }
}
```

`owner` 也可以写在插件目录的 `sync.config.json` 里；用户文件里的**空字符串不会覆盖**插件目录里已填的值（留空即"未指定"，要清空请写 `null`）。
`github.license` 留空表示不自动生成（只在状态里告警）；`github.copyright` 留空则用 `github.owner`。

> **Token 权限要求**（依据 GitHub REST 官方文档核实）
>
> **经典 Token（Classic）— 只勾 `repo` 就够：**
> - `repo` 已包含 `public_repo`，所以勾了它就同时覆盖公开仓库与私有仓库。
> - `POST /user/repos`（在自己账号下建仓）官方原文：*need the `public_repo` or `repo` scope to create a public repository, and `repo` scope to create a private repository.* → **`repo` 一个就够。**
> - `POST /orgs/{org}/repos`（在组织下建仓）官方原文同上，但额外要求：*The authenticated user must be a member of the organization.*
> - `repo` 同时给到代码读写，所以推送也用它。
> - 勾 `repo` 时 UI 会自动带上 `repo:status`、`repo_deployment`、`public_repo`、`repo:invite`，无害，不用管。`security_events`、`delete_repo`、`write:packages` 都不需要。
> - **唯一例外**：若某插件目录含 `.github/workflows/*.yml`，需要额外勾 `workflow`（授予"添加和更新 Actions 工作流文件"）。首次推送到空仓库时不存在"同名同内容的旧分支"，那条豁免不成立。
>
> **细粒度 Token（Fine-grained）：**
> - 推送代码：`Contents: Read and write`。
> - 自动新建仓库：`Administration: write` **或** `Repository creation: write`（官方为"满足其一"）。
> - 打 topics：`Administration: write`。
> - 组织启用了 SAML SSO 时，token 需单独授权给该组织，否则 403。
>
> 权限不足时不用猜：报错会直接打出 HTTP 状态码与对应提示（401 认证失败 / 403 权限不足 / 404 看不到）。分支保护导致推送被拒时会明确说是分支保护，而不是伪装成别的错误。

### 2. 在会话中触发

```text
/git
```
或带上意图：
```text
/git 把 github-sync 插件推到 GitHub
```

### 3. 命令与工具说明

- `/git [要求]`：触发同步意图，注入当轮说明并授权当轮推送。
- `github_sync_status`：只读查看配置、token 来源、git 可用性、插件清单、协议与镜像位置（只读，不联网）。
- `github_sync_plan`：试运行（Dry Run），列出将提交/排除的文件与原因、会打的 topic、协议是沿用还是生成。`verbose` 可看全部排除项（只读，不提交也不推送）。
- `github_sync_push`：真正的提交与推送。默认**增量提交 + 普通 push**；`force: true` 才会用单次快照替换远端历史。仓库不存在时按 `visibility` 自动创建，随后打 topics。**仅在被 `/git` 授权的那一轮可用。**

---

## 常见的几件运维事

| 想做的事 | 怎么做 |
|---|---|
| 只想看会发生什么 | `github_sync_plan`（或 `github_sync_push` 加 `dryRun: true`），都不提交、不推送 |
| 重跑一次被拒的推送 | 直接再推一次：会先 fetch 远端再提交，通常就正常了 |
| 某个提交必须从历史里消失 | `github_sync_push` 带 `force: true`（远端历史被替换成单次快照） |
| 镜像状态坏了 | 删掉 `%USERPROFILE%\.dsh\github-sync\mirrors\<仓库名>`，下次自动重建 |
| 某个插件不想带协议 | 该插件目录放自己的 `LICENSE`（会被沿用），或给该插件设 `license: ""` |

---

## 改代码之后：模块缓存（实测结论）

DSH 的 Loader **按模块 URL 缓存**，并且**不看内容与修改时间**：文件内容改掉之后，运行中的进程仍然复用旧模块。实测过两次，结论是：

- **只改入口文件名不够。** 单独把入口改名、模块目录原样不动，宿主依旧跑旧逻辑 —— 因为被 import 的模块 URL 没变。
- **每个改过内容的文件都必须换 URL。** 要么重启 DSH（最省心，推荐），要么把**改动的文件/目录一起改名**，再重新 enable 一次 bundle。
- `cordis.patch.yml` 里的 `name` 指向入口文件，入口改名时同步更新；`package.json` 的 `exports` / `files` 也要跟着改。

实际操作最省事的流程：**改完代码 → 重启 DSH**。只有在不能重启时才用改名法。

## 目录结构

```
main.mjs                入口：系统提示词闸门 + /git 指令 + 三个工具 + 守卫
core/config.js          配置合并、凭据定位、命名与 topic 规范化、告警
core/discover.js        插件发现 + dsh- 前缀约定（文件夹即仓库名）
core/manifest.js        干净副本清单 + 密钥扫描 + glob/gitignore 匹配
core/license.js         协议检测与生成（正文取自 GitHub 官方接口并缓存）
core/git.js             常驻镜像、增量提交、普通/强制推送、凭据助手
core/github.js          REST：建仓、查仓库、打 topics
core/sync.js            计划 / 执行编排（命名阻断、协议、topics、结果汇总）
core/prompt.js          /git 闸门（按会话、按轮次授权）与工具守卫
sync.config.json        插件自带配置（只放通用默认值）
sync.status.json        运行期诊断（自动生成，永不推送）
```

（`src/`、`lib/`、`internal/` 与 `index.js`、`host.mjs`、`plugin.mjs` 都是同一份代码的早期名字：因为上面的模块缓存机制，每次改动都得换 URL，所以历史名被留在了旧代次里。今后请优先重启 DSH，别靠改名。）
