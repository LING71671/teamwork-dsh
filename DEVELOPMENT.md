# DSH 插件开发版

当前交付：`0.2.0-dev.1`，已加入独立评审与验收 Gate，仍不是完整首版功能。

已经实现：独立 Runtime、SQLite 状态/事件/命令去重/outbox、host 工具、worker checkpoint/submit、每 Attempt 一个 DSH SDK 进程、工作副本、取消与超时、SSE 事件补读、保守重启恢复、内容摘要绑定的 Candidate 快照、全新只读评审 Attempt、独立验收命令及确定性 Gate。

尚未实现：自动修复迭代、产物下载、自动集成、暂停/恢复、slash commands、OpenCode/Pi 适配。不会把这些未实现能力显示成成功。

## 开发和验证

要求 Node.js >= 22.13；本机验证环境为 Windows、Node.js 22.22.1、DSH/SDK/tools `0.1.2-rc.1`、Cordis `4.0.2`。Node 22 内置 SQLite 会显示 experimental warning。

```powershell
Set-Location C:\work\teamwork-dsh
npm ci --registry=https://registry.npmjs.org
npm test
```

目前有 35 项自动化测试。真实 DSH 集成测试分别覆盖单实现者和“实现者 → 全新评审者 → 验收命令 → Gate”；测试专用离线 LLM adapter 调用真实 `read`、`write`、`teamwork_checkpoint`、`teamwork_submit`。评审阶段故意尝试写入，验证 guard 拒绝，同时检查两个 session 不同、原目录未变。测试不发送网络模型请求、不需要 API key，不等同于真实模型效果验收。其他测试覆盖去重、身份/版本拒绝、候选篡改、负面评审、验收失败/超时/改写输入、取消、重载和恢复。

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

## 在 DSH 中加载 host 插件

在另一个 PowerShell 终端设置连接记录，按你使用的 DSH profile 启动，例如 web：

```powershell
$env:TEAMWORK_CONNECTION_FILE = 'C:\work\teamwork-runtime-data\connection.json'
dsh --profile web --patch C:\work\teamwork-dsh\examples\host.cordis.patch.yml
```

示例 patch 使用 `file:///C:/.../host.js` 模块 URL。Windows 上不能把 `C:/...` 裸路径直接当作 ESM import specifier。移动项目后相应调整 patch。也可以在已完成安装的包中引用 `@teamwork/dsh-plugin/host`，但此开发版尚未发布到 npm。

插件只注册三个模型工具，不自动发起工作：

| 工具 | 输入 |
|---|---|
| `teamwork_start` | `commandId`、`objective` |
| `teamwork_status` | `runId` |
| `teamwork_control` | `runId`、`commandId`、`expectedRevision`、`type: "cancel"` |

开始例子：`{"commandId":"fix-edge-001","objective":"修复边界行为并补充离线单元测试；不要安装依赖。"}`。保存返回的 runId；网络重试使用同一 commandId 和相同内容。取消前查询最新 revision。插件重载只重建连接，不启动第二个 Run。Runtime 重启会更新端口/令牌，随后重载 host 插件以重新读取连接文件。

## 状态含义

未开启验证时，`queued → starting → running → submitted` 是报告收集链；`submitted` 只表示接到结构化报告、DSH 报告 completed turn、且其专有 runtime 进程退出已确认，`gate` 为 `not_evaluated`。

开启验证时，链路为 `running → freezing → reviewing → validating → verified/rejected`。先关闭实现者，再复制 Candidate 并校验 SHA-256 树摘要；评审和验收均从此 Candidate 获得独立副本。评审必须提交 `report.review.functionality`、`completeness`（pass/fail）和 `findings`。只有实现报告无未解决项、评审两项通过且无 findings、所有命令 exit 0，以及候选/评审输入完整性满足时，Gate 才为 passed。`verified` 只代表此候选在该策略下通过，不代表已经集成，也不是功能绝对正确的证明。

`running/starting → stopping → cancelled` 只有在确认退出后完成。退出未知进入 `blocked`，不得假报取消成功。`idle` 没有 submit、执行失败或超时进入 `failed`。

结果代码留在状态返回的 `order.workspace` 中；开启验证时以 `candidate.workspace` / `candidate.digest` 标识被验收的候选。快照是逻辑上的内容冻结，不是 OS 不可写文件；Gate 前会重新校验，后续使用仍需检查摘要。不会自动复制回原项目。

## HTTP 接口（开发协议 0.2）

host 与 Runtime 应一起更新；hello 会报告 `verificationEnabled`。协议 0.1 的旧 host 会在握手时拒绝不匹配版本，避免默默开启新的工作流程。

所有请求使用 `Authorization: Bearer <scoped-token>`。写请求为 JSON，256 KiB 上限。仅监听 `127.0.0.1`，拒绝浏览器 Origin 与不匹配 Host，不开启 CORS。

| 路由 | 凭证与用途 |
|---|---|
| `GET /v1/hello` | host；协议与实际能力 |
| `POST /v1/runs` | host；异步创建 |
| `GET /v1/runs/{runId}` | host；最新状态 |
| `POST /v1/runs/{runId}/commands` | host；仅 cancel |
| `GET /v1/runs/{runId}/events?after={cursor}` | host；SSE 补读，事件 ID 是持久游标 |
| `POST /v1/attempts/{attemptId}/checkpoint` | 该 Attempt 独有凭证 |
| `POST /v1/attempts/{attemptId}/submit` | 该 Attempt 独有凭证 |

worker 从进程环境绑定 epoch、inputDigest 和根 session ID，不允许模型自行提供身份，不持有 host 令牌。摘要报告是未经独立验证的声明；没有证据文件读取接口。HTTP client 不自动重试写入，调用者可用相同 commandId 查询/重试。

## 恢复与边界

- 正常关闭后 queued outbox 可在重启时派发。已 claim、freezing、reviewing、validating 中断时均保守进入 blocked；不会自动续跑验证或重试旧进程。review dispatch intent 先于创建进程持久化，已完成的命令证据不会丢失；退出未知会停止本 Runtime 的新派发。
- 异常退出遗留 `runtime.lock` 时会拒绝启动。先人工确认旧 Runtime 与其 worker 已停止，再归档该锁文件；保留 SQLite 和 attempt 目录，然后重启。不会只凭 PID 杀进程。
- 初始副本包含普通文件的未提交改动，排除 `.git`、`node_modules`、`.teamwork`、`.env*` 和 `.npmrc`；拒绝 symlink/junction/特殊文件和已存在目标，限制 20,000 条目/100 MiB。Candidate/评审/验收的后续复制不再过滤文件，避免静默改变候选。不是全量依赖镜像，未提供依赖安装流程。
- 副本不是操作系统沙箱，复制期间也不是原目录的原子快照。DSH 自身的 sandbox/approval 策略仍然有效；只有显式配置了硬隔离，才有对应安全保证。
- 实现者 guard 限制已知读写/搜索/shell/报告工具及 PTC 传输，拒绝其他工具和 `run_in_background`。评审者强制使用 native 工具呈现，只允许读/搜索/报告，禁止 shell、写入和代码执行。shell 和验收命令仍可能产生外部进程；本版本只确认所拥有的直接进程，不保证逃逸子进程的回收。
- `connection.json` 是 host 管理凭证；不要提交到仓库或提供给模型。目录访问权限在 Windows 上依赖 ACL，Unix mode 不能代替 Windows ACL。该实现不防御同一 OS 用户下恶意进程读取文件或环境。
- 自动修复迭代、自动集成和中断续跑仍是下一阶段，未通过整个 DSH 首版的发布门槛。

## 源码边界

`contracts.ts` / `kernel.ts` 不导入 DSH。`store.ts` / `runtime.ts` 是可复用执行服务；`client.ts` 是宿主无关 HTTP 客户端。DSH 依赖集中在 `driver-dsh.ts` 与 `plugin-dsh/`，为后续 OpenCode、Pi 入口和执行器保留替换点。

接口以固定 npm 版本的实际类型和测试为准，不跟随 GitHub master 浮动。外部参考：[DSH SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/client)、[Cordis 扩展方式](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)。
