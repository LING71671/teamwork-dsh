# Teamwork for DeepSeek Harness

A portable teamwork orchestration runtime, with DeepSeek Harness (DSH) as its first integration.

面向多种 Harness 的独立编排核心，优先接入 DSH。公开版本为 **0.2.0-dev.1 预发布版**；当前工作树是尚未发布的 **0.3.0-dev.1**，新增有限次数修复、暂停/恢复和候选验证队列恢复。不是完整产品。

本项目为独立实现，不是 DeepSeek 或 Google 的官方产品，也不包含其私有运行样本或内部提示词。

## 当前能力

- Host 工具：`teamwork_start`、`teamwork_status`、`teamwork_control`（取消；0.3 还支持暂停、恢复和显式需求修订）。
- 0.3 的 `teamwork_inspect` 提供摘要校验后的产物分页读取、变更清单，以及针对当前项目的只读三方集成冲突预览。
- 独立 Runtime：SQLite 状态、幂等命令、dispatch outbox、可补读的 SSE 事件。
- 每个 Attempt 使用独立工作副本、DSH SDK 进程和作用域凭证；支持超时与取消。
- 可选验证：候选内容摘要 → 全新只读评审 → 独立验收命令 → 确定性 Gate。
- 0.3 的 start 支持结构化需求及文件/目录变更范围；评审逐项回答需求，Runtime 检查范围并拒绝越界候选。
- `revise` 保存旧版本证据、冻结当前项目为新基线，撤销旧 Gate 并使已停止的派生工作过期；新版本重新实现、评审和验收。
- 可选 `budget.maxModelAttempts` 是跨实现、评审、修复、恢复、需求修订和派生任务的总额度，不是逐步审批；预留额度内自动派发，耗尽后才暂停。它不是 Token 或金额限额。
- 未授权自动集成时不改写原项目。`verified` 表示候选通过当前验收策略，不表示已集成。
- 0.3 可显式启用 `teamwork_integrate`：先预览并授权，再串行写回、保留备份并验收最终合并树；支持取消与有条件的“保留当前文件”处理。
- 创建时提供 `autonomy: {"integration":"on-gate-pass"}` 与明确 spec，即可一次授权后自动完成 Gate → 预检 → 串行写回 → 最终验收，不需要第二次集成批准。冲突修复的自动派发仍待实现。
- 冲突可通过 `teamwork_integrate` 的 `resolve` 创建新工作项：以当前项目为基线，只读查看三方输入，重新实现、独立评审并验收；有已接受的自动写回策略时通过后自动集成，否则仍用显式集成命令。

0.3 工作树还支持操作者配置的 1–5 轮有限修复和逐轮证据保留；默认只执行一轮。暂停提供 drain / interrupt；恢复使用新会话而非重新连接旧进程。集成默认关闭，必须配置 `integration.enabled: true` 并通过创建时策略或显式命令授权，示例见 `examples/runtime.integration.example.json`。尚未实现：完整 RunSpec、未知进程强证据对账、批量产物导出、slash commands、OpenCode/Pi 适配。完整开发方向见 [ROADMAP](ROADMAP.md)。后续适配顺序为 DSH → OpenCode → Pi。

## 从源码使用

要求 Node.js >=22.13，当前测试基线为 Windows / Node.js 22.22.1。

```sh
git clone https://github.com/LING71671/teamwork-dsh.git
cd teamwork-dsh
git checkout v0.2.0-dev.1
npm ci --registry=https://registry.npmjs.org
npm test
```

`v0.2.0-dev.1` 有 35 项测试，当前 0.3 工作树有 195 项。`npm test` 会构建源码并执行测试，包括真实 DSH SDK/Cordis 的离线模型适配器、逐项需求评审与变更范围、需求修订与旧证据失效、三方冲突解决后独立验证、显式集成到临时项目、保留用户改动、最终验收，以及进程退出恢复；不需要 API key，也不验证真实模型的任务效果。

编辑 `examples/runtime.example.json` 中的绝对路径和 DSH 模型路由，按实际位置修改 `examples/host.cordis.patch.yml`。示例路径仅为占位，不会替换你的凭据。

```sh
npm start -- --config examples/runtime.example.json --doctor
npm start -- --config examples/runtime.example.json
```

在另一终端设置 `TEAMWORK_CONNECTION_FILE` 指向 Runtime 生成的 `connection.json`，再使用示例 patch 启动 DSH host。完整配置、验收示例、协议和限制见 [开发指南](DEVELOPMENT.md)。真正发起任务时，DSH 会使用你配置的模型服务，可能产生费用。

## Release 安装包

[Releases](https://github.com/LING71671/teamwork-dsh/releases) 提供编译后的 npm 格式 `.tgz` 和 SHA-256 校验文件。可在独立安装目录执行 `npm install /absolute/path/teamwork-dsh-plugin-0.2.0-dev.1.tgz`，然后使用 `npx teamwork-runtime --config /absolute/path/runtime.json`。宿主必须能够解析已安装的 `@teamwork/dsh-plugin/host`，或使用其绝对 `file://` 模块 URL。

当前未发布到 npm registry；`private: true` 用于防止误发布，不影响本地 tarball 安装。源码和编译包均采用 [MIT 许可证](LICENSE)。

## 安全与边界

工作副本不是操作系统沙箱。只对合作式任务使用；当前不保证逃逸子进程回收，也不防御同一 OS 用户下的恶意进程。评审工具权限有限，但实现者 shell 与验收程序仍需操作者信任。

不要提交 `connection.json`、环境凭据或运行状态。中断后的已派发进程无法证明退出时会进入 `blocked`，不会自动重派。请先阅读 [恢复与边界](DEVELOPMENT.md#恢复与边界)。

## 开发与贡献

核心位于 `contracts.ts` / `kernel.ts` / `store.ts` / `runtime.ts`；DSH 集中在 `driver-dsh.ts` 和 `plugin-dsh/`。提交改动前运行 `npm test`，协议变化应同步更新客户端、测试和文档。

欢迎通过 Issues 报告问题或提交 Pull Request。请附版本、复现步骤和脱敏日志，不要上传令牌、真实会话内容或私有项目文件。版本记录见 [CHANGELOG](CHANGELOG.md)。
