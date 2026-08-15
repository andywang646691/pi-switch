# AGENTS.md — pi-switch

## 项目结构

- `src-rust/` — Rust 核心（napi 绑定，通过 `index.js` 导出给 Node）
- `webui/` — React + Vite Web UI；**构建产物 `webui/dist` 在编译期通过 rust-embed 嵌入 `.node` 原生二进制**（`src-rust/web.rs`），不是独立静态文件
- `bin/pi-switch.js` — CLI 入口
- `extensions/` — pi 扩展（conversation-id-inject、failover-watchdog）
- `.github/workflows/ci.yml` — CI：verify + 5 平台构建 + npm publish

## 构建（本机）

```bash
npm run build:webui     # 构建 WebUI → webui/dist
npm run build:native    # 构建 napi .node 二进制（嵌入 webui/dist）
npm run build           # webui + native
```

## ⚠️ 发布流程（重要教训，2026-08-14）

**普通 push 到 `main` 分支不会触发任何 CI 构建。** `.github/workflows/ci.yml` 的触发条件是：

```yaml
on:
  push:
    tags: ["v*"]        # 只有推送 v* tag 才触发
  pull_request:
    branches: [main]    # PR 仅验证，不发布
```

`publish` job 还硬性要求 `startsWith(github.ref, 'refs/tags/v')`。**没有 `branches: [main]` 的 push 触发**，也没有自动打 tag 的机制。

### 发布步骤

1. 在 `package.json` 中 bump 版本号（如 `0.5.6`），commit
2. 推送代码到 main：`git push origin main`
3. **必须手动打 tag（版本号必须与 package.json 一致）**：
   ```bash
   git tag v0.5.6
   git push origin v0.5.6
   ```
4. CI 自动完成：构建 5 平台 `.node` 二进制 → `npm publish`
5. 验证：
   ```bash
   gh run list                # 确认 CI 成功
   npm view @andywangzzm/pi-switch version   # 确认 npm 已是最新
   ```

### 教训

0.5.6 的功能（rawlog 请求/响应捕获、Raw Logs WebUI 页等）已提交到 main，但**忘记打 tag**，导致：
- CI 从未触发，npm 上停留在 0.5.5
- 用户全局安装的仍是旧版，WebUI 里没有 Raw Logs 模块

**规则：每次功能完成后，必须检查并完成打 tag 发布，否则 CI 不构建、npm 不更新。** WebUI 改动只有发布新版本用户才能看到——因为 WebUI 是编译期嵌入二进制的。

### CI 构建范围（2026-08-15 调整）

`.github/workflows/ci.yml` 默认**只构建 macOS 两个平台**（x86_64 / aarch64）：
- `pull_request` / 手动触发（未勾选）→ 只 macOS
- `workflow_dispatch` 勾选 `all-platforms` → 全平台
- **发布（v* tag）→ 始终全平台**（npm 包需要全部 `.node` 二进制，缺了其他平台用户装不上）

## 信号处理与进程管理（前台卡死事故修复，2026-08-15）

### 事故根因（双层）

前台模式进程（有 TTY）收到 SIGTERM/SIGINT 时：
1. Node 默认为这两个信号预装 `SignalExit → ResetStdio → tcsetattr` 处理器，在异常/挂起的终端上死循环，进程退不掉
2. Rust 侧 `tokio::signal` 注册时（signal-hook）会**链式调用**已安装的旧处理器——即使 Rust 侧消费了信号，Node 的 SignalExit 仍会被链式触发并卡死

（SIGHUP 无 Node 默认处理器，SIG_DFL 不被链式调用，所以只挂 TERM/INT）

### 修复机制

- `bin/pi-switch.js` 前台分支：调用 `runProxyServer` 前先注册**空信号处理器**（SIGTERM/SIGHUP/SIGINT），替换 Node 默认 SignalExit；链式调用时执行的是无害空回调
- `src-rust/lib.rs` `shutdown_signal()`：Rust 侧消费 SIGINT/SIGTERM/SIGHUP → axum graceful shutdown → napi Promise resolve → Node await 返回 → 进程退出（tokio 线程随进程终止）；另加 5s watchdog 强退兜底
- `src-rust/daemon.rs`：`daemon_stop` 无 pid 文件但端口被 pi-switch 进程占用时，按端口反查（lsof/netstat）并校验命令行含 `pi-switch` 后终止——清理失控前台实例；`daemon_status` 同步提示端口占用

### 注意

- daemon 子进程与前台模式走**同一代码路径**（`daemon_start` spawn 不带 `--daemon` 的子进程），修复对两种模式统一生效
- 前台模式不写 pid 文件（避免与 daemon pid 文件冲突），失控清理靠 `proxy stop` 的端口兜底
- Windows：`process.on('SIGTERM')` 无效但无害；Rust 侧 `not(unix)` 分支保持 ctrl_c + watchdog

## CLI 语义教训（前台模式误判事故，2026-08-15）

**`pi-switch proxy start` / `webui start` 不带 `--daemon` 就是前台模式：进程挂载前台、永不退出，这是设计行为，不是 bug。**

### 事故经过

重启 daemon 时误用了 `pi-switch proxy start`（不带 `--daemon`），看到命令 120s 不退出就断定“挂起”并超时杀掉——实际杀掉的是一个合法的前台实例。真正的守护进程方式是 `--daemon`。

### 规则

- 对不熟悉命令的异常行为（挂起、超时、无输出），**先读 `bin/pi-switch.js` 的 usage / 对应分支代码确认语义，再决定是否“修”**
- 守护进程方式：`pi-switch proxy start --daemon`（spawn 独立子进程，日志写 `~/.pi-switch/proxy.log`）；前台方式用于调试，Ctrl+C 优雅退出
- `proxy stop` 会按 pid 文件终止；前台实例无 pid 文件，靠端口反查兜底（见“信号处理”一节）

## 测试

```bash
npm test                          # node --test extensions/**/*.test.ts
cargo test --release --lib        # Rust 单测
npm --prefix webui run test       # WebUI vitest
npm --prefix webui run typecheck  # WebUI 类型检查
```
