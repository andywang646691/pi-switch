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

## 测试

```bash
npm test                          # node --test extensions/**/*.test.ts
cargo test --release --lib        # Rust 单测
npm --prefix webui run test       # WebUI vitest
npm --prefix webui run typecheck  # WebUI 类型检查
```
