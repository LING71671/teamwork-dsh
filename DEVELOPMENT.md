# DSH 插件开发版

当前工作树：`0.3.0-dev.1`（尚未发布），已加入有限次数修复、暂停/恢复与候选验证队列恢复；已发布基线为 `v0.2.0-dev.1`。仍不是完整首版功能。

已经实现：独立 Runtime、SQLite 状态/事件/命令去重/outbox、host 工具、worker checkpoint/submit、每 Attempt 一个 DSH SDK 进程、工作副本、取消与超时、SSE 事件补读、保守重启恢复、内容摘要绑定的 Candidate 快照、全新只读评审 Attempt、独立验收命令及确定性 Gate。

已加入显式启用的集成、最终验收、有条件的保留当前文件处理及冲突解决工作项。尚未实现：完整 RunSpec、未知进程强证据对账、slash commands、OpenCode/Pi 适配。产物已有分页读取和变更清单，尚无批量压缩包导出。不会把未实现能力显示成成功。完整开发的剩余方向见 [ROADMAP.md](./ROADMAP.md)。

## 开发和验证

要求 Node.js >= 22.13；本机验证环境为 Windows、Node.js 22.22.1、DSH/SDK/tools `0.1.2-rc.1`、Cordis `4.0.2`。Node 22 内置 SQLite 会显示 experimental warning。

```powershell
Set-Location C:\work\teamwork-dsh
npm ci --registry=https://registry.npmjs.org
npm test
```

目前有 138 项自动化测试。真实 DSH 测试覆盖单实现者、完整评审/Gate、四进程失败修复链，以及“checkpoint → 中断并确认退出 → 新实现者 → 新评审 → 验收”三进程恢复链；离线 LLM adapter 调用真实工具，不发送网络模型请求、不需要 API key。显式集成测试进一步将真实 DSH 的候选写回临时项目，保留期间新增的用户文件并重新验收；冲突链覆盖读取三方内容、产生新候选、独立评审、再次显式集成。其他测试覆盖去重、身份/版本拒绝、候选和上下文篡改、读取凭证撤销、失败/超时/输入改写、暂停竞态、重载、产物权限与分页、三方冲突、SQLite 恢复、真实子进程退出边界、取消、保留当前文件、需求继承上限和新工作项事务回滚。这不等同于真实模型效果验收。

测试只使用临时 DSH_HOME，不修改用户 DSH profile。测试生成的临时副本和状态在结束后清理。

## 启动 Runtime

编辑 `examples/runtime.example.json`：`workspace` 是授权交给 worker 的项目，`dataDirectory` 必须在该项目之外，并位于当前用户专用的目录；配置模型路由为你已有的 DSH provider/model。示例不写入或替换凭据。

```powershell
# 仅检查版本和 SDK 初始化，不提交任务。
npm start -- --config C:\work\teamwork-dsh\examples\runtime.example.json --doctor

# 前台运行；Ctrl+C 关闭所拥有的执行进程，然后释放数据库。
npm start -- --config C:\work\teamwork-dsh\examples\runtime.example.json
```

Runtime 输出 loopback 地址和 `connection.json` 路径，不输出令牌。第一次调用 start 才运行模型；DSH 会按所选 profile 使用已有凭据。启动 DSH 本身可能按其常规行为初始化缺失的 profile；本插件不修改全局模型选择，也不注册系统服务。

一个数据目录只服务一个 workspace、固定执行 profile、验收策略和集成启用状态。更换 workspace/model/profile/verification 或启用 integration 时使用新的数据目录，避免旧队列被派往新的目标或改变原授权。运行期间不要修改 profile/overlay 文件和外部验收脚本；当前摘要记录配置值，不对这些外部文件做内容冻结。

## 启用独立评审与验收

不配置 `verification` 时保留旧的报告收集模式。配置后每次 start 会额外启动一个评审 DSH 进程（使用同一模型路由，但全新会话），可能增加模型费用。验收配置只能由操作者在 Runtime JSON 中指定，模型工具没有修改权限。

完整示例见 `examples/runtime.verification.example.json`：项目 `examples/verification-project/sum.mjs` 故意没有处理空数组，可提交任务“修复 sum 对空数组的行为，使其返回 0，保持其他求和行为”。独立验收脚本 `examples/sum-acceptance.mjs` 位于项目之外，明确通过 **进程 cwd** 加载待测候选，避免误测原项目。

```json
"verification": {
  "commands": [{
    "id": "sum-acceptance",
    "executable": "C:/Program Files/nodejs/node.exe",
    "args": ["C:/work/teamwork-dsh/examples/sum-acceptance.mjs"],
    "timeoutMs": 10000
  }]
}
```

更换路径为本机实际路径。命令按顺序在验收副本中执行，要求至少一条、ID 唯一、executable 为绝对路径；使用 `shell: false`，不展开管道或通配符。Windows 的 npm.cmd 等包装器不作为直接 executable，请使用 node.exe 和相应 JS 入口。验收环境只继承 PATH、系统目录、临时目录和语言设置，不继承 API key、TEAMWORK 令牌、NODE_OPTIONS 等变量；没有自动安装依赖。

每条命令的退出码、状态、耗时及 stdout/stderr 各末尾 16 KiB 作为未信任的诊断输出持久化。允许新增构建产物，但改写/删除候选原有输入会拒绝 Gate 并停止剩余命令。验收脚本应由用户控制，最好放在实现者的工作项目之外；本版本不防御恶意测试、同用户跨目录访问或逃逸子进程。

## 有限次数修复（协议 0.3）

在 Runtime 配置的 `verification` 中显式设置 `"maxIterations": 2` 可启用修复；范围为 1–5，包含第一轮，不设置等同于 1。该配置仅由操作者决定，host/worker 工具不能增大预算。示例见 `examples/runtime.repair.example.json`。每轮会启动实现者和全新评审者，可能增加模型费用。

当实现报告不完整、评审否决或验收命令失败/超时时，且完整性与证据检查通过、仍有预算，Gate 将失败轮与新的 outbox 意图在同一事务中持久化，进入 `repair_queued`。随后为相同 WorkItem 创建全新 Attempt、dispatchKey、凭证和工作目录，epoch 增加，原始 objective/specRevision 不变。新工作副本来自上一轮候选，不来自原项目，也不携带验收生成物。

状态中的 `iteration` 表示当前轮次，`history` 保留已归档失败轮的候选摘要、实现报告、评审、验收输出与 Gate 原因。修复 worker 收到最多 16,000 字符的未信任诊断文本；新评审者不继承修复反馈。所有旧轮的新提交均被拒绝，历史幂等 receipt 重放不会改写新轮。

候选/评审/验收输入被篡改、验收程序无法启动、证据陈旧或不完整、进程退出未知时，不会自动修复。预算耗尽以 `rejected` 结束。待派发修复可以取消；重启时未 claim 的修复 outbox 可恢复，已 claim 的修复仍保守隔离为 `blocked`。原项目保持不变。

## 在 DSH 中加载 host 插件

在另一个 PowerShell 终端设置连接记录，按你使用的 DSH profile 启动，例如 web：

```powershell
$env:TEAMWORK_CONNECTION_FILE = 'C:\work\teamwork-runtime-data\connection.json'
dsh --profile web --patch C:\work\teamwork-dsh\examples\host.cordis.patch.yml
```

示例 patch 使用 `file:///C:/.../host.js` 模块 URL。Windows 上不能把 `C:/...` 裸路径直接当作 ESM import specifier。移动项目后相应调整 patch。也可以在已完成安装的包中引用 `@teamwork/dsh-plugin/host`，但此开发版尚未发布到 npm。

插件注册五个模型工具，不自动发起工作：

| 工具 | 输入 |
|---|---|
| `teamwork_start` | `commandId`、`objective` |
| `teamwork_status` | `runId` |
| `teamwork_control` | `runId`、`commandId`、`expectedRevision`、`type: "cancel" / "pause" / "resume"`；仅 pause 可带 `mode` |
| `teamwork_inspect` | `runId`、`kind: "artifacts" / "manifest" / "file" / "changes" / "integration" / "integrations"`，其他字段见下节 |
| `teamwork_integrate` | `runId`、`commandId`、`expectedRevision`、`type: "integrate" / "cancel" / "abandon" / "resolve"`，计划/集成 ID 与决策字段见集成章节 |

开始例子：`{"commandId":"fix-edge-001","objective":"修复边界行为并补充离线单元测试；不要安装依赖。"}`。保存返回的 runId；网络重试使用同一 commandId 和相同内容。取消前查询最新 revision。插件重载只重建连接，不启动第二个 Run。Runtime 重启会更新端口/令牌，随后重载 host 插件以重新读取连接文件。

## 状态含义

未开启验证时，`queued → starting → running → submitted` 是报告收集链；`submitted` 只表示接到结构化报告、DSH 报告 completed turn、且其专有 runtime 进程退出已确认，`gate` 为 `not_evaluated`。

开启验证时，链路为 `running → freezing → verification_queued → verification_starting → reviewing → validating → verified/rejected`。先关闭实现者，再复制 Candidate 并校验 SHA-256 树摘要；将固定 Candidate 和验证 outbox 原子持久化，之后才派发评审。评审和验收均从此 Candidate 获得独立副本。评审必须提交 `report.review.functionality`、`completeness`（pass/fail）和 `findings`。只有实现报告无未解决项、评审两项通过且无 findings、所有命令 exit 0，以及候选/评审输入完整性满足时，Gate 才为 passed。`verified` 只代表此候选在该策略下通过，不代表已经集成，也不是功能绝对正确的证明。

`running/starting → stopping → cancelled` 只有在确认退出后完成。退出未知进入 `blocked`，不得假报取消成功。`idle` 没有 submit、执行失败或超时进入 `failed`。

结果代码留在状态返回的 `order.workspace` 中；开启验证时以 `candidate.workspace` / `candidate.digest` 标识被验收的候选。快照是逻辑上的内容冻结，不是 OS 不可写文件；Gate 前会重新校验，后续使用仍需检查摘要。不会自动复制回原项目。

## HTTP 接口（开发协议 0.3）

host 与 Runtime 应一起更新；hello 会报告 `verificationEnabled`、`maxIterations` 和 `bounded-repair` / `pause` / `resume` / `candidate-recovery` 能力。协议 0.1/0.2 的旧 host 会在握手时拒绝不匹配版本，避免默默开启新的工作流程。不要用旧 Runtime 打开含新状态的数据目录。

所有请求使用 `Authorization: Bearer <scoped-token>`。写请求为 JSON，256 KiB 上限。仅监听 `127.0.0.1`，拒绝浏览器 Origin 与不匹配 Host，不开启 CORS。

| 路由 | 凭证与用途 |
|---|---|
| `GET /v1/hello` | host；协议与实际能力 |
| `POST /v1/runs` | host；异步创建 |
| `GET /v1/runs/{runId}` | host；最新状态 |
| `POST /v1/runs/{runId}/commands` | host；cancel / pause / resume |
| `GET /v1/runs/{runId}/events?after={cursor}` | host；SSE 补读，事件 ID 是持久游标 |
| `GET /v1/runs/{runId}/artifacts` | host；分页列出已登记的基线、候选与暂停快照 |
| `GET /v1/runs/{runId}/artifacts/{artifactId}` | host；核对树摘要并分页列出文件/目录 |
| `GET /v1/runs/{runId}/artifacts/{artifactId}/file?path={relativePath}` | host；核对文件摘要并分页读取内容 |
| `GET /v1/runs/{runId}/changes` | host；原始基线到当前或指定候选/暂停快照的精确变更清单 |
| `GET /v1/runs/{runId}/integration-preview` | host；基线、候选和当前配置项目的只读三方冲突预览 |
| `POST /v1/runs/{runId}/integrations` | host；显式集成，配置启用且当前候选通过 Gate 才接受 |
| `GET /v1/runs/{runId}/integrations` | host；分页查询本 Run 的集成历史 |
| `GET /v1/runs/{runId}/integrations/{integrationId}` | host；最新集成状态、最终验收、恢复目录与产物引用 |
| `POST /v1/runs/{runId}/integrations/{integrationId}/commands` | host；cancel、abandon/保留当前文件或 resolve/返回新 Run |
| `GET /v1/attempts/{attemptId}/context` | 活动解决者/评审者独有凭证；只读三方上下文，kind 与 version 见下文 |
| `POST /v1/attempts/{attemptId}/checkpoint` | 该 Attempt 独有凭证 |
| `POST /v1/attempts/{attemptId}/submit` | 该 Attempt 独有凭证 |

worker 从进程环境绑定 epoch、inputDigest 和根 session ID，不允许模型自行提供身份，不持有 host 令牌。实际输入副本的 `inputTreeDigest` 在执行前绑定到 `inputDigest`；开始命令 receipt 中尚未绑定的旧摘要不能用于 worker 提交。报告仍是未经独立验证的声明。HTTP client 不自动重试写入，调用者可用相同 commandId 查询/重试。

## 产物与变更检查

第一次实现前会保存独立原始基线 `baseline`，其中包括初始副本中已存在的未提交修改。后续暂停、修复与恢复不替换这个基线。Candidate 与暂停快照在固定后获得 `artifactId`；注册记录和相关状态在同一 SQLite 事务中保存。模型报告中的路径不是产物授权依据。

`teamwork_inspect` 的 `kind: "artifacts"` 列出登记项；`manifest` 需要 artifactId；`file` 需要 artifactId 和标准化的相对路径；`changes` 默认比较原始基线与当前候选，也可指定某个历史候选或暂停快照的 artifactId。清单描述 added/deleted/modified/type_changed，含文件摘要、大小和执行位；不表示变更已集成或验收成功。

清单分页使用 `offset` 和 `limit`（默认 100、最大 500），返回 nextOffset；继续读变更清单时固定返回的 candidate.id，避免改读到新一轮候选。文件分页使用字节 offset 和 length（默认 16 KiB、最大 64 KiB），完整文件摘要校验通过后才返回该页；正常 UTF-8 页返回文本，二进制或切在 UTF-8 字符中间的页返回 base64。nextOffset 为 null 表示结束。

所有读取只接受本 Run 已登记的引用；拒绝 worker 凭证、跨 Run 引用、绝对路径、`..`、Windows ADS/device 路径、符号链接及摘要不匹配。最多同时执行 2 个文件/清单/变更检查，每次 15 秒上限。产物内容是未信任数据。旧数据目录中没有登记基线/产物的记录不会被猜测为可读文件；接口会报告缺失。

文件读取与变更清单不会写回原项目，也没有开放任意路径读取或任意产物注册的 HTTP 接口。

### 集成冲突预览（只读接口）

`teamwork_inspect` 使用 `kind: "integration"`，默认选当前 Candidate，也可用 artifactId 指定已登记的历史候选或暂停快照。Runtime 只读取其配置的原项目，不接受模型传入目标目录。清单对比最初基线、所选快照、当前项目；保留与候选变更无关的用户修改，不自动做同文件文本合并。

每项 disposition 是 `apply`（可计划应用）、`already_applied`（目标已是相同内容）或 `conflict`。冲突原因包括 `concurrent_change`、`ancestor_changed`、`descendant_changed`、`protected_path`、`path_alias`。整个计划的 status 为 clear/conflicts；即使当前分页没显示冲突，conflictCount 也计算完整清单。删除/替换目录时，用户新增或修改的子项会阻止操作；目录内 `.git`、`node_modules`、`.teamwork`、`.env`、`.env.*`、`.npmrc` 等排除项也会阻止操作，且不会读取其内容。过滤名称不区分大小写。大小写或 Unicode 规范化别名保守报冲突。

预览始终 `readOnly: true`，不持有锁、不建立持久集成事务、不修改 Run，也不表示操作者已授权写回。`candidateVerified` 只说明选中了当前已通过 Gate 的候选；它与冲突状态独立，不能充当最终集成验收。

分页 offset/limit 与产物清单相同。首屏返回内容绑定的 id；继续请求时传相同 candidate.id 为 artifactId、相同 id 为 planId。普通项目内容或受保护路径集合变化会返回 `INTEGRATION_PLAN_STALE`，需从第一页重新检查。预览期间仍可能发生并发编辑，它不是原子文件系统快照；未来执行器还必须在串行事务中重新检查每个 effect，不能直接执行旧预览。最多 2 个并发检查、15 秒请求上限与现有产物读取共享。

### 启用与发起集成

默认不启用集成。操作者在新数据目录的 Runtime 配置中加入 `"integration": {"enabled": true}`，且必须配置 verification。完整示例见 `examples/runtime.integration.example.json`。hello 返回 integrationEnabled；只有启用时才报告 integrate、integration-cancel、integration-keep-current、integration-resolve、resolution-context。配置启用只是允许显式命令，Gate 通过、插件加载和状态查询都不自动写回。

用户授权写回后，先调用 `teamwork_inspect`（kind integration）取得 planId，即预览返回的 id；再调用 `teamwork_integrate`，例如 `{"runId":"...","commandId":"integrate-001","type":"integrate","expectedRevision":42,"planId":"<64位摘要>"}`。expectedRevision 是最新 **Run revision**，不是预览计划 ID 或集成 revision。HTTP 对应 POST integrations，省略 body 内 runId。模型不能提供目标目录、修改验收命令或跳过 Gate。重复/并发请求以同 commandId 和完全相同内容得到持久回执；回执是接受时的状态，不是最新执行状态。

Runtime 等当前模型 Attempt 排空后串行集成，期间不派发新工作副本。GET Run 的 `integration` 显示最新集成，`teamwork_inspect`（kind integrations）分页查询历史。每次集成更新与 Run 投影、SSE 事件在同一 SQLite 事务中提交。**Run.phase 仍为 verified；只有 integration.phase 为 succeeded 才表示该次最终合并树通过验收。** 集成中的 prepared/applying/snapshotting/validating 不是成功，conflict/failed/blocked/abandoned 也不是。

停止集成用 `teamwork_integrate` 的 type cancel，提供 integrationId 和最新 **Integration revision**。尚未 claim 的 prepared 可以 cancelled，不改项目；已在运行时先记录 cancelRequested 并等待执行器/直接验收进程停止，可能留下部分写入，随后进入 blocked。普通 teamwork_control 的 cancel 不会把仍在集成的 verified Run 当作已取消。集成失败或 blocked 会保留源目录租约，暂停新工作派发，等待处理。

### 集成日志与最终验收

内部 prepare 要求当前 Run 已 verified、Gate 通过、输入身份与候选登记一致，并提供当前 revision 和预览 planId。同一 SQLite 数据库保存 `integration_jobs`、`integration_events` 和 `integration_leases`；源目录租约阻止第二个未解决集成。项目父目录还创建排他 reservation 文件，防止不同数据目录的执行器同时操作同一项目；不会通过 PID 猜测或抢占未知拥有者。恢复调用者仍必须先持有 Runtime 数据目录的独占所有权。

执行器在源目录同级创建唯一 `.teamwork-integration-<id>` 目录保存 owner、原文件备份、快照和验收副本。每个 effect 先持久化 intent，再操作文件，最后持久化 done。旧文件通过同卷 rename 保留到备份；新文件先复制并校验到暂存，再通过排他的 hardlink 原子发布，完成后移除暂存链接，使正常完成的目标不与暂存共享 inode。不会用 rename 覆盖目标，也不会在跨设备错误时改用“复制后删除”。删除目录只用非递归 rmdir，目录中新出现的用户文件会阻止删除。

进程退出后，Runtime 会继续已获授权的待派发集成，并按备份摘要、暂存摘要与发布身份核对未确认的文件 effect；不能证明的情况进入 blocked。旧的内部实验记录若未标记 host 授权，不会被自动派发。原文件被移走之后若目标出现新用户文件，不覆盖新文件，也不把备份强行还原。已发生的部分写入、备份目录和 reservation 均保留；失败不是“原项目未变”的承诺。不提供自动回滚。

写入完成后，目标普通文件树必须等于“prepare 时的用户项目 + 候选变更”，包括用户原有的无关修改。独立冻结该最终合并树，再复制到另一个目录运行原验收命令；构建输出不写入项目/冻结快照，原始输入不能被验收改写。最终成功同时要求当前项目仍匹配合并树、快照摘要未变、每条命令都有当前结果且 exitCode 为 0。候选 Gate 通过而最终集成验收失败时，内部记录为 failed，并保留写入与备份，不冒充集成成功。

最终快照在验收前登记为 integrated 产物，可通过现有 manifest/file 接口检查；产物存在本身不代表验收通过。验收 command intent 先于启动进程保存；若没有持久结果或停止证据，恢复进入 `EXTERNAL_STATE_UNKNOWN`，不自动重跑可能有外部副作用的命令。正常取消得到直接进程退出确认后会持久化 commandStop，不把它当作通过的命令证据。测试覆盖真实子进程在文件移动/发布与日志确认之间退出、在最终命令结果保存前退出、SQLite 重新打开，以及恢复时的用户改动和路径重定向。

### 人工选择保留当前文件

用户明确选择放弃这次集成、保留当前项目时，可对已停止的 failed/blocked 集成调用 `teamwork_integrate`，type abandon，附 integrationId、最新 Integration revision、当前集成预览的 targetDigest 和非空 reason。此操作不重试、不回滚、不删除备份，也不表示任务成功。它仅在当前项目摘要仍匹配时释放**该次集成自己**的 reservation 和源租约，状态从 abandoning 到 abandoned，允许后续显式工作。

退出未知的 commandIntent 不能用 abandon 清除，文字说明不能替代退出证据；仍在执行的 writer 也不能被 abandon。foreign reservation 不会被抢占或删除。决策和命令回执先持久化，释放 reservation 后发生进程退出可恢复完成，不重复改写项目。若期间用户又修改项目，报告过期并保留占用，需重新检查后提交新决策。恢复目录在 recoveryDirectory；备份仍保留供人工检查。未知进程的强证据对账及恢复/还原选项仍待开发。

这些保证针对合作式本地任务与进程崩溃，不是整棵树的原子事务、断电持久性保证或对抗同一 OS 用户恶意文件系统竞争的沙箱。Windows 权限依赖继承 ACL。原文件备份不会自动删除；后续需要独立的留存/清理策略。

### 创建冲突解决工作项

用户授权解决冲突后，对已记录的 `conflict` 集成调用 `teamwork_integrate`，type resolve。先刷新 `teamwork_inspect`（kind integration）取得当前 planId，并查询集成最新 revision。示例：

```json
{
  "runId": "<父 Run ID>",
  "integrationId": "<冲突集成 ID>",
  "commandId": "resolve-001",
  "type": "resolve",
  "expectedRevision": 1,
  "planId": "<当前预览的 64 位摘要>",
  "instructions": "保留用户增加的边界处理，同时合入原候选的功能；不要安装依赖。"
}
```

expectedRevision 是实际查询到的 **Integration revision**，示例值不能照抄。HTTP 对应 POST integration commands，省略 body 中的 runId/integrationId。响应为 HTTP 202 和**新 Run**，不是旧集成状态；后续查询和控制使用该新 Run 的 id。旧集成保持 conflict/abandoned，不会被重写成成功；其 resolutionRunId 指向最新解决工作项。相同 commandId/内容重试重放原新 Run 回执，不重复启动模型。

failed/blocked 集成必须先满足退出证据要求，并由用户显式完成 abandon/保留当前文件决策，达到 abandoned 后才能 resolve。此时即使没有文件级冲突，也可处理最终验收失败等语义问题。未解决源租约、活动集成或未知 commandIntent 不能通过创建工作项绕过。若旧 conflict 对应的当前冲突已消失，resolve 返回 CONFLICTS_CLEARED，应重新检查并另行授权集成。

新工作项继承原 objective 和操作者验收策略，创建全新 Run/WorkItem/Attempt，specRevision 递增，初始 epoch 为 1。它从 resolve 时冻结的**当前用户项目**开始，不从旧 proposal 开始，也不直接改写原项目。该当前副本成为新 Run 基线；旧 base/proposal 作为登记的只读上下文引用。新 Run、三方产物登记、outbox、父集成关联、事件和命令回执在同一 SQLite 事务提交，失败时一起回滚。准备期间失败可能保留未登记副本，但不会派发它或写回项目。

实现者和全新只读评审者额外获得 `teamwork_context`：`kind: conflicts` 分页列出冲突；`kind: manifest` 需 `version: base / proposal / current`；`kind: file` 还需标准化相对 path。分页参数与产物接口相同，不接受任意 artifactId、外部目录或跨工作项凭证。普通 worker 不加载此工具；活动凭证只允许读自己的登记上下文，submit、取消、interrupt 或 epoch 替换后拒绝旧读者。读文件时校验登记摘要，派发和新 Gate 前也检查全部三方输入。副本仍是逻辑冻结，不是 OS 不可写文件。

解决者必须保留用户改动并考虑旧 proposal 中未冲突的功能，不能只处理冲突列表后丢弃其余目标。新评审独立检查原目标、三方参考与附加需求，新验收重新执行；旧评审和旧命令结果不作为新 Gate 证据。此前集成诊断最多 16,000 字符，只是未信任提示。每次 instructions 为 1–16,000 字符；多代解决工作项继承所有附加需求，按换行拼接计最多 32,000 字符，超限明确返回 RESOLUTION_BUDGET，不静默截断。

新 Run 支持有限修复、暂停和恢复；排队后重启仍使用已冻结的 current，而不吸收后来的源项目改动。同一集成已有活动、paused、verified 或 blocked 的解决工作项时拒绝重复创建；只有上一个 failed/cancelled/rejected 后才能另行显式创建替代项。resolve 会启动新的模型工作并可能产生费用，不自动循环。

新候选通过 Gate 后，必须针对**新 Run**重新预览并显式发起 integrate，最终合并树再验收通过才算该次集成成功。期间用户再次修改相同文件会产生新的冲突，需要新的明确决策。这不是自动文本合并、自动覆盖或备份还原功能。

## 恢复与边界

### 暂停与手动恢复

暂停示例：`{"commandId":"pause-001","expectedRevision":12,"type":"pause","mode":"drain"}`。恢复示例：`{"commandId":"resume-001","expectedRevision":15,"type":"resume"}`。工具调用还需 `runId`；HTTP 路由已包含 runId。revision 使用每次查询返回的实际值；精确重试必须复用相同 commandId 和内容。

`drain`（默认）等待当前模型 Attempt 或当前验收命令结束，不派发下一项。`interrupt` 请求停止并确认所拥有的执行退出。两者均先显示 `pausing`（`pause.stage` 保留活动阶段），冻结可恢复内容后才显示 `paused`。尚未派发的队列直接 paused。暂停期间可以取消；drain 可升级为 interrupt，但不能反向降级。

只有 paused 才能 resume。中断实现者后，从暂停快照与 checkpoint 创建全新 Attempt、凭证和目录，epoch 递增，iteration 不增加；原始需求与修复预算不变。之前的记录保存在 `suspensions`。如果复制尚未完整完成，则不使用部分副本；恢复时重新制作完整输入。报告只是提示上下文，恢复后的实现者必须重新 submit。

若实现者已经正常结束且候选已固定，则直接恢复验证，不重跑实现。暂停评审/验收后的恢复会创建全新评审与验收副本，重新运行验证，旧验证记录保留在 suspensions 而不用于新 Gate。因而 resume 可能再次调用模型、重新执行验收程序；这些程序应可复跑。未启用 verification 的正常排空提交可直接恢复为 submitted，不启动新模型。

退出未知仍为 blocked；自然执行失败不会因为 pause 被包装成成功或可恢复结果。暂停快照/候选被篡改时，恢复在启动新进程前失败。

### 重启与隔离限制

- queued、repair_queued 和 verification_queued 的未 claim outbox 可在重启时派发；verification_queued 从固定 Candidate 开始验证，重新校验摘要，不重跑实现。paused 跨重启保持暂停，只有显式 resume 才继续。已 claim、freezing、reviewing、validating、pausing 中断时仍保守进入 blocked；不会重用未知旧进程。review dispatch intent 先于创建进程持久化，已完成的命令证据不会丢失；退出未知会停止本 Runtime 的新派发。
- 异常退出遗留 `runtime.lock` 时会拒绝启动。先人工确认旧 Runtime 与其 worker 已停止，再归档该锁文件；保留 SQLite 和 attempt 目录，然后重启。不会只凭 PID 杀进程。
- 初始副本包含普通文件的未提交改动，排除 `.git`、`node_modules`、`.teamwork`、`.env*` 和 `.npmrc`；拒绝 symlink/junction/特殊文件和已存在目标，限制 20,000 条目/100 MiB。Candidate/评审/验收的后续复制不再过滤文件，避免静默改变候选。不是全量依赖镜像，未提供依赖安装流程。
- 副本不是操作系统沙箱，复制期间也不是原目录的原子快照。DSH 自身的 sandbox/approval 策略仍然有效；只有显式配置了硬隔离，才有对应安全保证。
- 实现者 guard 限制已知读写/搜索/shell/报告工具及 PTC 传输，拒绝其他工具和 `run_in_background`。评审者强制使用 native 工具呈现，只允许读/搜索/报告，禁止 shell、写入和代码执行。shell 和验收命令仍可能产生外部进程；本版本只确认所拥有的直接进程，不保证逃逸子进程的回收。
- `connection.json` 是 host 管理凭证；不要提交到仓库或提供给模型。目录访问权限在 Windows 上依赖 ACL，Unix mode 不能代替 Windows ACL。该实现不防御同一 OS 用户下恶意进程读取文件或环境。
- 显式集成、最终验收、文件 effect 恢复、保留当前文件处理及新冲突解决工作项已接入 Runtime/DSH；未知进程强证据对账、完整 RunSpec 和完整首版发布门槛仍未完成。

## 源码边界

`contracts.ts` / `kernel.ts` 不导入 DSH。`store.ts` / `runtime.ts` 是可复用执行服务；`client.ts` 是宿主无关 HTTP 客户端。DSH 依赖集中在 `driver-dsh.ts` 与 `plugin-dsh/`，为后续 OpenCode、Pi 入口和执行器保留替换点。

接口以固定 npm 版本的实际类型和测试为准，不跟随 GitHub master 浮动。外部参考：[DSH SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/client)、[Cordis 扩展方式](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)。
