# Regenic GitHub Copilot connector

Local connector and task executor for the **GitHub Copilot CLI SDK**. This package does not import history from Copilot CLI's native storage, VS Code Chat, the Copilot desktop app, or Copilot cloud coding agent.

## What it supports

- **Run Regenic Agent tasks** through the official `@github/copilot-sdk`, in an explicitly configured local workspace.
- **Synchronize sessions created by this connector** using the SDK's persisted session events. Arbitrary pre-existing SDK/CLI sessions are not imported.
- Map user and assistant messages to conversation records and tool start/completion events to work records. Tool arguments and tool output are not copied into synced records.
- Resume and inspect only runs recorded in the connector-owned manifest. A run whose create/send outcome is uncertain is not submitted again automatically.

This connector does not create chat threads or send replies. The SDK's `getEvents()` API returns a session's full event history; the connector limits records delivered per poll but currently must read that full history for each poll.

## Install from this repository

Use the repository as the plugin deployment root so its scoped dependency override and lockfile remain effective:

```sh
git clone https://github.com/regenic-ai/regenic-connector-github-copilot.git
cd regenic-connector-github-copilot
pnpm install --frozen-lockfile
pnpm run build
pnpm audit --prod
```

Set `REGENIC_CHANNEL_PLUGIN` to the absolute path of this built repository when starting the Regenic API. Its local plugin loader reads the package manifest and synchronous entry point. Keep this repository's `node_modules` alongside the build; do not copy only `dist` into another dependency root.

**Direct npm/tarball installation into an arbitrary application is not recommended without a root-level scoped override and a clean production audit.** Package consumers do not inherit this repository's overrides. See the dependency compatibility requirements below. This connector is not being published to npm as part of this change.

## Configure an installation

Set the following fields in the Regenic GitHub Copilot CLI installation:

| Field | Requirement |
| --- | --- |
| `copilot_home` | Absolute path to an existing Copilot home configured for the official SDK. |
| `state_dir` | Absolute path for connector-owned state. The connector creates it with owner-only permissions; it must not overlap the Copilot home or workspace. |
| `working_directory` | Absolute path to an existing workspace. |
| `sync_enabled` | Optional; defaults to `false`. Enables synchronization of connector-created sessions. |
| `execution_enabled` | Optional; defaults to `false`. Explicitly enables direct task execution. |
| `available_tools` | When execution is enabled, a comma- or newline-separated allowlist of exact `builtin:<name>` SDK tool names. Empty lists, wildcards, MCP, custom, and plugin tools are rejected. |
| `permission_timeout_ms` | Optional; defaults to five minutes; accepted range is 1,000–900,000 milliseconds. |

Authentication is handled by the official SDK using the Copilot account configured for the selected home. This connector does not read or store account tokens. When a task runs, the SDK makes its normal service requests; installation discovery and catalog operations do not start a Copilot process.

After enabling execution, use **Engine → Executors → Local connector → Install** and select this connector installation. The equivalent API is `POST /v1/me/executors` with `{ "kind": "local_connector", "config": { "installation_id": "<connector-installation-id>" } }`. Use the returned executor `id` as the recipe's `executor_type`; do not put an installation ID in recipe configuration.

This package targets `@github/copilot-sdk@1.0.28` and requires Regenic's direct-executor installation support plus published `@regenic/connector-contract@^0.3.0`. The committed lockfile resolves public registry packages.

### SDK dependency compatibility

The latest stable SDK 1.0.28 pins Zod 4.3.6, affected by GHSA-mrhx-c7xc-m3w5. This repository applies only `@github/copilot-sdk@1.0.28>zod: 4.6.7` in pnpm overrides, not a global override. Offline tests exercise the real SDK's CommonJS/ESM tool-schema conversion, structured-result parsing and public schema types with Zod 4.6.7. SDK 1.0.29-preview.1 declares the patched Zod but also changes other dependencies; this package does not switch to that prerelease.

**Dependency overrides do not propagate from a published package to its consumers.** Until a compatible stable SDK fixes its dependency, the installing application's root manifest must apply the same scoped override (or the package manager's equivalent) and verify its own production audit. This repository's clean audit is not proof that an arbitrary consumer resolves the patched dependency.

The connector explicitly selects the SDK's child-process `stdio` transport. `koffi` is required by the SDK's separate experimental in-process FFI transport, loaded lazily; that transport is not supported here. An ignored `koffi` build script is not a stdio prerequisite, but the platform-specific SDK runtime package and OS prerequisites still are. Tests do not launch the bundled runtime or validate live subprocess cleanup.

## Permission and workspace boundary

Execution starts only when the installation is enabled and `execution_enabled` is true. The host must mount this executor as a fixed local-connector installation; the executor requires the host-pinned installation ID and rejects an unpinned invocation.

The SDK runs in `empty` mode with only the configured built-in tool allowlist. MCP, custom tools, plugins, skills, configuration discovery, file hooks, and telemetry are disabled. SDK permissions use manual mode with automatic approval disabled. Permission prompts are default-deny and can be approved once by the Regenic user; pending approval metadata is persisted without tool arguments and is revalidated against the SDK event history on resume. Unknown, stale, expired, replayed, or unsupported requests are denied.

**The configured workspace is not a security sandbox.** A tool may be able to access files outside the workspace or use network access according to the host OS and SDK. The tool allowlist and approval prompts reduce exposure but do not replace OS isolation. Do not enable tools or execute tasks unless the local machine and workspace are trusted.

## Privacy and support boundaries

- The connector stores a private manifest containing connector-created session IDs, installation/org/run ownership, status, timestamps, and one-way permission-request digests. It does not store prompt arguments, permission arguments, credentials, or tool output in that manifest.
- Session text is synchronized only when `sync_enabled` is enabled. The SDK's own session store remains owned by the SDK.
- No local history directory is scanned or guessed. Native CLI/VS Code/Desktop/Cloud session formats are not supported.
- Polling paginates delivered records and uses persisted event IDs as cursors. Ephemeral streaming deltas are not checkpointed or synchronized. Unknown or malformed persisted SDK events and missing saved cursors fail explicitly rather than returning an empty successful result.
- The connector does not read referenced files or attachments, execute session-provided paths/commands itself, or modify/delete SDK session data.

## Development

The package requires Node.js `^20.19.0 || >=22.12.0`. Build and run the synthetic tests with:

```sh
pnpm run typecheck
pnpm test
```

Tests use a fake SDK client and generated event fixtures; they do not authenticate, launch a real Copilot process, or read real session data.

## Regenic GitHub Copilot connector (简体中文)

本包通过官方 `@github/copilot-sdk` 提供本地连接器和任务执行器。它**不**导入 Copilot CLI 原生历史、VS Code Chat、Copilot 桌面应用或 Copilot 云端 coding agent 的会话。

### 支持范围

- 在明确配置的本地工作区中执行 Regenic Agent 任务。
- 通过 SDK 的持久化 session events 同步**由本连接器创建**的会话；不导入任意既有会话。
- 将用户/助手消息映射为对话记录，将工具开始/完成事件映射为工作记录；同步记录不包含工具参数和工具输出。
- 只恢复连接器私有清单登记的任务。创建或发送结果不确定时不会自动重发。

连接器不创建聊天线程，也不代发回复。SDK `getEvents()` 会返回完整会话事件；连接器限制每次 poll 交付的记录数量，但目前每次 poll 仍需读取完整事件历史。

### 从本仓库安装

克隆本仓库，在仓库根目录依次运行 `pnpm install --frozen-lockfile`、`pnpm run build` 和 `pnpm audit --prod`，保留定向 override 和 lockfile。启动 Regenic API 时，将 `REGENIC_CHANNEL_PLUGIN` 设为该已构建仓库的绝对路径；宿主本地插件 loader 读取包 manifest 和同步入口。保留仓库旁的 `node_modules`，不要仅将 `dist` 复制到另一依赖根目录。

**不推荐在未配置安装方根级定向 override、未通过生产审计时直接将 npm/tarball 包安装进任意应用。** 安装方不会继承本仓库的 override；具体要求见下方依赖兼容性说明。本次变更不发布连接器到 npm。

### 安装配置

配置 `copilot_home`（已配置官方 SDK 的绝对路径）、`state_dir`（连接器私有状态目录）和 `working_directory`（已存在的工作区）。私有状态目录由连接器以仅所有者可访问权限创建，不能与 Copilot home 或工作区重叠。`sync_enabled` 与 `execution_enabled` 均默认关闭。启用执行时必须配置精确的 `builtin:<name>` 工具白名单；不接受通配符、MCP、自定义工具或插件工具。权限提示超时默认五分钟，可设为 1,000–900,000 毫秒。

认证由官方 SDK 使用所选 home 中已配置的 Copilot 账户处理；连接器不读取或保存账户 token。执行任务时 SDK 会按正常方式访问其服务；安装发现和目录查询不会启动 Copilot 进程。

启用执行后，在 **Engine → Executors → Local connector → Install** 中选择该连接器安装。等价 API 为 `POST /v1/me/executors`，请求体为 `{ "kind": "local_connector", "config": { "installation_id": "<connector-installation-id>" } }`。将返回的 executor `id` 用作 recipe 的 `executor_type`，不要在 recipe 配置中填写安装 ID。

本包针对 `@github/copilot-sdk@1.0.28`，依赖 Regenic 的 direct-executor 安装支持及已发布的 `@regenic/connector-contract@^0.3.0`。已提交的 lockfile 使用公共 registry 包。

### SDK 依赖兼容性

最新稳定 SDK 1.0.28 固定使用受 GHSA-mrhx-c7xc-m3w5 影响的 Zod 4.3.6。本仓库仅对 `@github/copilot-sdk@1.0.28>zod` 定向 override 至 4.6.7，不全局覆盖。离线测试使用真实 SDK 的 CommonJS/ESM 工具 schema 转换、结构化响应解析及公开 schema 类型验证兼容性。1.0.29-preview.1 已声明修复版 Zod，但同时修改其他依赖；本包不切换到该预发布版本。

**发布包中的 override 不会自动传递给安装方。** 在兼容的稳定 SDK 修复依赖之前，安装应用必须在根 manifest 中配置相同定向 override（或包管理器的等价配置），并独立验证生产依赖审计；本仓库审计通过不代表任意安装方都会解析到修复版本。

连接器明确选择子进程 `stdio` transport。SDK 仅在实验性进程内 FFI transport 中延迟加载 `koffi`，本连接器不支持该 transport，因此忽略 `koffi` 构建脚本不影响 stdio 的前置条件；但对应平台的 SDK runtime 包和操作系统前置条件仍然必需。测试不启动 bundled runtime，也未验证真实子进程清理。

### 权限与工作区边界

执行要求安装启用且明确设置 `execution_enabled=true`，同时由宿主固定绑定 local-connector installation ID；缺少宿主 pin 时拒绝执行。SDK 使用 `empty` 模式，仅暴露已配置的内置工具白名单；关闭 MCP、自定义工具、插件、skills、配置发现、文件 hooks 和 telemetry。权限模式为 manual，自动批准关闭；权限请求默认拒绝，Regenic 用户只能对单次请求明确批准。待批准元数据不保存工具参数，恢复时会依据 SDK 事件历史重新核验；未知、过期、重放或不受支持的请求会被拒绝。

**配置的工作区不是安全沙箱。** 工具仍可能依据操作系统权限访问工作区之外的文件或使用网络。白名单和审批不能替代操作系统隔离；仅在本机与工作区可信时启用工具和执行任务。

### 隐私与限制

- 私有清单保存连接器创建的 session ID、安装/org/run 归属、状态、时间戳和单向权限请求摘要，不保存 prompt/权限参数、凭据或工具输出。
- 仅在开启 `sync_enabled` 后同步会话文本。SDK 自身的会话存储仍由 SDK 管理。
- 不扫描或猜测本地历史目录；不支持原生 CLI、VS Code、桌面应用或 Cloud 会话格式。
- poll 使用持久事件 ID 作为游标，不同步或 checkpoint 临时 streaming delta。未知或格式错误的持久化 SDK 事件、游标失效时会明确报错，不伪装成空成功结果。
- 不读取引用文件或附件、不执行会话提供的路径/命令、不修改或删除 SDK 会话数据。

### 开发

要求 Node.js `^20.19.0 || >=22.12.0`。运行 `pnpm run typecheck` 和 `pnpm test`。测试仅使用 fake SDK client 与合成事件，不认证、不启动真实 Copilot，也不读取真实会话数据。
