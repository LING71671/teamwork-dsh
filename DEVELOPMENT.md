# DSH 插件开发版

当前工作树：`0.3.0-dev.1`（尚未发布），已加入有限次数修复、暂停/恢复与候选验证队列恢复；已发布基线为 `v0.2.0-dev.1`。仍不是完整首版功能。

已经实现：独立 Runtime、SQLite 状态/事件/命令去重/outbox、host 工具、worker checkpoint/submit、每 Attempt 一个 DSH SDK 进程、工作副本、取消与超时、SSE 事件补读、保守重启恢复、内容摘要绑定的 Candidate 快照、全新只读评审 Attempt、独立验收命令及确定性 Gate。

尚未实现：自动集成、slash commands、OpenCode/Pi 适配。产物已有分页读取和变更清单，尚无批量压缩包导出。不会把未实现能力显示成成功。完整开发的剩余方向见 [ROADMAP.md](./ROADMAP.md)。

## 开发和验证

要求 Node.js >= 22.13；本机验证环境为 Windows、Node.js 22.22.1、DSH/SDK/tools `0.1.2-rc.1`、Cordis `4.0.2`。Node 22 内置 SQLite 会显示 experimental warning。

```powershell
Set-Location C:\work\teamwork-dsh
npm ci --registry=https://registry.npmjs.org
npm test
```

目前有 74 项自动化测试。真实 DSH 集成测试覆盖单实现者、完整评审/Gate、四进程失败修复链，以及“checkpoint → 中断并确认退出 → 新实现者 → 新评审 → 验收”三进程恢复链；测试专用离线 LLM adapter 调用真实 `read`、`write`、`teamwork_checkpoint`、`teamwork_submit`。评审阶段故意尝试写入，验证 guard 拒绝，同时检查 session 身份、原目录未变。测试不发送网络模型请求、不需要 API key，不等同于真实模型效果验收。其他测试覆盖去重、身份/版本拒绝、候选篡改、负面评审、验收失败/超时/改写输入、迭代上限、旧轮结果、暂停竞态、取消、重载、SQLite 重开恢复、产物权限/路径/摘要与分页、原始基线和精确变更清单。

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

一个数据目录只服务一个 workspace、固定执行 profile 和验收策略。更换 workspace/model/profile/verification 时使用新的数据目录，避免旧队列被派往新的目标。运行期间不要修改 profile/overlay 文件和外部验收脚本；当前摘要记录配置值，不对这些外部文件做内容冻结。

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

插件注册四个模型工具，不自动发起工作：

| 工具 | 输入 |
|---|---|
| `teamwork_start` | `commandId`、`objective` |
| `teamwork_status` | `runId` |
| `teamwork_control` | `runId`、`commandId`、`expectedRevision`、`type: "cancel" / "pause" / "resume"`；仅 pause 可带 `mode` |
| `teamwork_inspect` | `runId`、`kind: "artifacts" / "manifest" / "file" / "changes"`，其他字段见下节 |

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

### 内部集成执行器（尚未接入用户命令）

源码中的 `IntegrationEngine` 已具备实际写回与最终验收路径，测试只在临时项目中调用它。Runtime 调度器、HTTP 控制命令和 DSH 插件目前**不会调用此执行器**，也不把这部分能力报告为可用的自动集成。尚需操作者显式启用配置、幂等命令、状态/事件、取消/恢复入口、集成产物登记与冲突解决工作项。

内部 prepare 要求当前 Run 已 verified、Gate 通过、输入身份与候选登记一致，并提供当前 revision 和预览 planId。同一 SQLite 数据库保存 `integration_jobs`、`integration_events` 和 `integration_leases`；源目录租约阻止第二个未解决集成。项目父目录还创建排他 reservation 文件，防止不同数据目录的执行器同时操作同一项目；不会通过 PID 猜测或抢占未知拥有者。恢复调用者仍必须先持有 Runtime 数据目录的独占所有权。

执行器在源目录同级创建唯一 `.teamwork-integration-<id>` 目录保存 owner、原文件备份、快照和验收副本。每个 effect 先持久化 intent，再操作文件，最后持久化 done。旧文件通过同卷 rename 保留到备份；新文件先复制并校验到暂存，再通过排他的 hardlink 原子发布，完成后移除暂存链接，使正常完成的目标不与暂存共享 inode。不会用 rename 覆盖目标，也不会在跨设备错误时改用“复制后删除”。删除目录只用非递归 rmdir，目录中新出现的用户文件会阻止删除。

进程退出后，可按备份摘要、暂存摘要与发布身份核对未确认的文件 effect；不能证明的情况进入 blocked。原文件被移走之后若目标出现新用户文件，不覆盖新文件，也不把备份强行还原。已发生的部分写入、备份目录和 reservation 均保留供后续人工对账；失败不是“原项目未变”的承诺。目前没有用户可用的自动回滚或解除租约入口。

写入完成后，目标普通文件树必须等于“prepare 时的用户项目 + 候选变更”，包括用户原有的无关修改。独立冻结该最终合并树，再复制到另一个目录运行原验收命令；构建输出不写入项目/冻结快照，原始输入不能被验收改写。最终成功同时要求当前项目仍匹配合并树、快照摘要未变、每条命令都有当前结果且 exitCode 为 0。候选 Gate 通过而最终集成验收失败时，内部记录为 failed，并保留写入与备份，不冒充集成成功。

验收 command intent 先于启动进程保存；若进程退出时没有持久结果，恢复进入 `EXTERNAL_STATE_UNKNOWN`，不自动重跑可能有外部副作用的命令。测试覆盖真实子进程在文件移动/发布与日志确认之间退出、在最终命令结果保存前退出、SQLite 重新打开，以及恢复时的用户改动和路径重定向。

这些保证针对合作式本地任务与进程崩溃，不是整棵树的原子事务、断电持久性保证或对抗同一 OS 用户恶意文件系统竞争的沙箱。Windows 权限依赖继承 ACL。原文件备份不会自动删除；后续需要独立的留存/清理策略。

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
- 内部集成执行器和文件 effect 恢复已开发并测试，但尚未接入 Runtime/DSH 用户控制链；自动集成、人工对账入口及完整首版发布门槛仍未完成。

## 源码边界

`contracts.ts` / `kernel.ts` 不导入 DSH。`store.ts` / `runtime.ts` 是可复用执行服务；`client.ts` 是宿主无关 HTTP 客户端。DSH 依赖集中在 `driver-dsh.ts` 与 `plugin-dsh/`，为后续 OpenCode、Pi 入口和执行器保留替换点。

接口以固定 npm 版本的实际类型和测试为准，不跟随 GitHub master 浮动。外部参考：[DSH SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/client)、[Cordis 扩展方式](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)。
