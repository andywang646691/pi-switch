import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "zh";

// zh translations, keyed by the English UI string. Missing keys fall back to
// English, so untranslated strings degrade gracefully.
const zh: Record<string, string> = {
  // App / nav
  Home: "首页",
  Profiles: "供应商",
  Proxy: "代理",
  Packages: "包管理",
  Stats: "统计",
  Backups: "备份",
  Settings: "设置",
  Doctor: "诊断",
  "provider control · web": "provider 管理 · Web",
  "control plane": "控制台",
  Workspace: "工作区",
  workspace: "工作区",
  "Core connected": "核心已连接",
  "Local instance": "本地实例",
  "CLI · TUI · WebUI — same core": "CLI · TUI · WebUI — 同一核心",
  "Could not load config": "无法加载配置",
  "Initialize config": "初始化配置",
  "Loading…": "加载中…",

  // Home
  Overview: "概览",
  "CLI / TUI / WebUI share one Rust core": "CLI / TUI / WebUI 共享同一 Rust 核心",
  Exposed: "已暴露",
  Current: "当前",
  running: "运行中",
  stopped: "已停止",
  "Gateway workflow": "网关工作流",
  "Add profiles & set API keys": "添加供应商并设置 API 密钥",
  "Expose models to pi (per profile)": "暴露模型到 pi（按供应商）",
  "Optionally set a failover chain": "可选：设置故障转移链",
  "Optionally set failover rules": "可选：设置故障转移规则",
  "Start the proxy — pi routes by profile/model": "启动代理 — pi 按 profile/model 路由",
  "Manage profiles": "管理供应商",
  "Proxy control": "代理控制",
  "Current selection": "当前选择",
  "Active profile:": "当前激活:",
  "Provider id:": "Provider id:",
  "No profile selected yet.": "尚未选择供应商。",
  "A clean path from provider to production traffic": "从供应商到生产流量的清晰路径",

  // Backups
  "config backups & encrypted sync": "配置备份与加密同步",
  "Config backups": "配置备份",
  Refresh: "刷新",
  "No backups yet.": "暂无备份。",
  "Restore this backup? Current config is backed up first.":
    "恢复此备份？当前配置会先备份。",
  Restore: "恢复",
  Restored: "已恢复",
  "Export (encrypted)": "导出（加密）",
  Passphrase: "密码",
  "Export config": "导出配置",
  Exported: "已导出",
  "Import (encrypted)": "导入（加密）",
  "File path": "文件路径",
  "Import config": "导入配置",
  Imported: "已导入",
  "Exported to:": "已导出到:",

  // Doctor
  "config & connectivity checks": "配置与连通性检查",
  "Re-run": "重新运行",
  "Health checks": "健康检查",
  "No checks.": "无检查项。",
  Validation: "校验",
  "No issues found.": "未发现问题。",

  // Proxy
  "proxy daemon & gateway": "代理守护进程与网关",
  Status: "状态",
  "Start proxy": "启动代理",
  "Stop proxy": "停止代理",
  "Target / Failover": "目标 / 故障转移",
  "Set target profile": "设置目标供应商",
  "Failover chain": "故障转移链",
  "Failover rules": "故障转移规则",
  "Rule-based, provider-level failover: the first matching rule decides the provider chain, tried in order. Proxy profiles are excluded.":
    "基于规则的 provider 级故障转移：第一条匹配的规则决定供应商链，按顺序尝试。代理 profile 不参与。",
  "No failover rules configured.": "未配置故障转移规则。",
  "Rule name (optional)": "规则名称（可选）",
  "e.g. deepseek-primary": "例如 deepseek-primary",
  "Model prefix": "模型名前缀",
  "Model contains": "模型名包含",
  "Provider chain (order = failover order)": "供应商链（顺序即故障转移顺序）",
  "No providers selected.": "未选择供应商。",
  "Add rule": "新增规则",
  "Save rules": "保存规则",
  "Rules saved": "规则已保存",
  "Proxy daemon is not running": "代理守护进程未运行",
  "Daemon controls": "守护进程控制",
  target: "目标",
  failover: "故障转移",
  "No proxy status available": "无代理状态信息",

  // Settings
  "preferences & proxy defaults": "偏好与代理默认值",
  "Write mode": "写入模式",
  "Language (TUI only — WebUI is English)": "语言（仅 TUI 生效 — WebUI 为英文）",
  auto: "自动",
  "Proxy host": "代理地址",
  "Proxy port": "代理端口",
  "User-Agent disguise": "User-Agent 伪装",
  none: "无",
  "Claude Code": "Claude Code",
  Codex: "Codex",
  Gemini: "Gemini",
  "Saved": "已保存",

  // Stats
  "proxy request usage": "代理请求用量",
  "By provider": "按供应商",
  "By model": "按模型",
  "By conversation": "按对话",
  "Recent requests": "最近请求",
  "No request data yet.": "暂无请求数据。",
  Today: "当天",
  "24h": "24h",
  "7d": "7天",
  Custom: "自定义",
  Input: "输入",
  Output: "输出",
  Cached: "缓存",
  Reasoning: "推理",
  Total: "合计",
  time: "时间",
  provider: "供应商",
  model: "模型",
  status: "状态",
  error: "错误",
  "cache rate": "缓存率",
  requests: "请求数",
  "End must be on or after start": "结束日期不能早于开始日期",
  "Select both start and end dates": "请选择起止日期",

  // Packages
  "Install, enable/disable, and manage packages": "安装、启用/禁用和管理包",
  "Import from Pi Agent": "从 Pi Agent 导入",
  "+ Add Package": "+ 添加包",
  Cancel: "取消",
  "Install Package": "安装包",
  Spec: "Spec",
  "e.g., npm:foo@1.0.0, git:github.com/user/repo, or local path":
    "例如：npm:foo@1.0.0、git:github.com/user/repo 或本地路径",
  Install: "安装",
  "No packages installed.": "未安装任何包。",
  'Click "Add Package" above or use CLI: pi-switch package add <id> <name> <version>':
    '点击上方"添加包"或使用 CLI：pi-switch package add <id> <名称> <版本>',
  ID: "ID",
  "Installed:": "安装于:",
  Enabled: "已启用",
  Disabled: "已禁用",
  Uninstall: "卸载",
  "Uninstall package '{{name}}'?": "卸载包 '{{name}}'？",
  "Package '{{spec}}' installed": "包 '{{spec}}' 已安装",
  "Package '{{name}}' disabled": "包 '{{name}}' 已禁用",
  "Package '{{name}}' enabled": "包 '{{name}}' 已启用",
  "Package '{{name}}' deleted": "包 '{{name}}' 已删除",
  "Packages imported from Pi Agent": "已从 Pi Agent 导入包",
  extensions: "扩展",
  skills: "技能",
  prompts: "提示词",
  themes: "主题",

  // Profiles
  "profile(s)": "个供应商",
  "+ Add profile": "+ 添加供应商",
  "⇥ Import from cc-switch": "⇥ 从 cc-switch 导入",
  "Add profile": "添加供应商",
  "Edit profile": "编辑供应商",
  Save: "保存",
  Name: "名称",
  "Base URL": "Base URL",
  "API key": "API 密钥",
  API: "API",
  Models: "模型",
  "comma separated": "逗号分隔",
  "Expose to pi": "暴露到 pi",
  Delete: "删除",
  "Profile '{{name}}' deleted": "供应商 '{{name}}' 已删除",
  "Profile '{{name}}' saved": "供应商 '{{name}}' 已保存",
  Duplicate: "复制",
  "Duplicate profile '{{name}}'?": "复制供应商 '{{name}}'？",
  "Edit models": "编辑模型",
  "Model id": "模型 ID",
  "Context window": "上下文窗口",
  "Max tokens": "最大 token",
  "No profiles yet.": "暂无供应商。",
  search: "搜索",
  "Import from cc-switch": "从 cc-switch 导入",
  "No importable providers found in cc-switch.": "cc-switch 中未找到可导入的 provider。",
  "Path to cc-switch.db (optional)": "cc-switch.db 路径（可选）",
  Retry: "重试",
  "Import selected": "导入选中",
  exists: "已存在",
  "Nothing imported (already exist or skipped).": "未导入任何内容（已存在或已跳过）。",
  "Imported {{n}} provider(s) from cc-switch": "已从 cc-switch 导入 {{n}} 个 provider",
  "Provider name": "供应商名称",
  Responses: "Responses",
  "Responses mode": "Responses 模式",
  "automatic by API type": "按 API 类型自动选择",
  "native Responses only": "仅原生 Responses",
  "Chat Completions only": "仅 Chat Completions",
  "passthrough requires openai-responses": "passthrough 需要 openai-responses",
  "convert requires openai-completions": "convert 需要 openai-completions",


  // ui.tsx
  OK: "确定",
  Close: "关闭",

  // Proxy panel
  "routes by profile/model in the request body": "按请求体中的 profile/model 路由",
  "Proxy started": "代理已启动",
  "Proxy stopped": "代理已停止",
  Start: "启动",
  Stop: "停止",
  "Same-model fallback order when the primary provider fails. Proxy profiles are excluded.":
    "主 provider 失败时按同模型回退顺序。代理 profile 已排除。",
  "No failover configured.": "未配置故障转移。",
  "+ add profile…": "+ 添加 provider…",
  "Failover saved": "故障转移已保存",
  "Save chain": "保存链",

  // Stats panel
  "Export JSON": "导出 JSON",
  "Export CSV": "导出 CSV",
  "No request data yet. Start the proxy and make some requests.": "暂无请求数据。请启动代理并发送一些请求。",

  // Raw request/response log
  "Raw Logs": "请求日志",
  "Raw request & response log": "请求与上游响应原始日志",
  "raw-requests.log — Web UI only": "raw-requests.log — 仅在 Web UI 查看",
  "showing latest": "显示最新",
  "Clear all": "清空全部",
  "No raw logs yet. Make requests through the proxy to capture raw bodies.": "暂无原始日志。通过代理发送请求后即可捕获原始数据。",
  failed: "失败",
  Request: "请求",
  "Request headers": "请求头",
  "Request body": "请求体",
  "Upstream headers": "上游响应头",
  "Upstream body": "上游响应体",
  Attempt: "尝试",
  "No body captured": "未捕获到请求体",
  "Truncated — only the first portion was captured": "已截断 — 仅捕获了开头部分",
  "Clear raw logs? This permanently deletes all captured requests and responses.": "清空原始日志？这将永久删除所有捕获的请求与响应数据。",
  Cleared: "已清空",
  "Capture raw request/response logs": "捕获原始请求/响应日志",
  "Stores raw client requests and upstream responses (capped) in raw-requests.log, viewable in the Web UI only.": "将客户端请求与上游响应的原始数据（限量）存入 raw-requests.log，仅可在 Web UI 中查看。",
  Failed: "失败",
  Success: "成功率",
  "Cache rate": "缓存率",
  "Avg latency:": "平均延迟:",
  Provider: "Provider",
  Rate: "成功率",
  Tokens: "Token",
  "Request details": "请求明细",
  Time: "时间",
  Model: "模型",
  Session: "会话",
  Routing: "路由",
  "Failover succeeded": "故障转移成功",
  "Recovered to primary": "已回切主 provider",
  "Upstream failed": "上游失败",
  "Circuit skipped": "熔断跳过",
  Primary: "主 provider",
  Cost: "消费",
  From: "开始",
  To: "结束",
  "Auto-refresh": "自动刷新",
  "Previous page": "上一页",
  "Next page": "下一页",
  "Rows per page": "每页行数",
  "Conversation from": "对话开始",
  "Conversation to": "对话结束",
  "Previous conversation page": "上一对话页",
  "Next conversation page": "下一对话页",
  "Conversation rows per page": "对话每页行数",
  "No conversation data in this range.": "该时间段内暂无对话数据。",
  "Failed to load conversation requests": "加载对话请求失败",
  "No requests in this conversation": "此对话暂无请求",
  rows: "行",
  "unknown cost rows": "行未知消费",

  // Settings panel
  "written to ~/.pi-switch/config.json": "写入 ~/.pi-switch/config.json",
  General: "常规",
  "Provider prefix (pi gateway id)": "Provider 前缀（pi 网关 ID）",
  Language: "语言",
  "Current UI language": "当前界面语言",
  "Global User-Agent disguise": "全局 User-Agent 伪装",
  "Circuit breaker enabled": "启用断路器",
  "Failure threshold": "失败阈值",
  "Cooldown (seconds)": "冷却（秒）",
  "Web UI": "Web UI",
  "Non-loopback hosts require Basic auth (password in ~/.pi-switch/webui_password). Changes take effect on next webui start.":
    "非本机地址需要 Basic 认证（密码在 ~/.pi-switch/webui_password）。修改在下次 webui start 时生效。",
  "Settings saved": "设置已保存",
  "Save settings": "保存设置",

  // Profiles panel
  current: "当前",
  proxy: "代理",
  exposed: "已暴露",
  "no base url": "无 base URL",
  models: "个模型",
  Use: "使用",
  "Switched to": "已切换到",
  Edit: "编辑",
  Test: "测试",
  "Testing…": "测试中…",
  "Test all": "测试全部",
  "Testing all…": "全部测试中…",
  reachable: "可达",
  "Proxy profiles are skipped": "proxy 配置（元配置）不参与测试",
  Reachable: "连接正常",
  "Connection failed": "连接失败",
  "Test OK": "测试通过",
  Copy: "复制",
  Duplicated: "已复制",
  Deleted: "已删除",
  "Duplicate profile '{{name}}' as:": "复制供应商 '{{name}}' 为:",
  "Delete profile '{{name}}'?": "删除供应商 '{{name}}'？",
  "name required": "名称必填",
  "Preset (prefill)": "预设（预填）",
  "API type": "API 类型",
  "Disguise (User-Agent)": "伪装（User-Agent）",
  "API key (supports $ENV_VAR)": "API 密钥（支持 $ENV_VAR）",
  "Model IDs (one per line)": "模型 ID（每行一个）",
  "Mark as a proxy profile (excluded from failover, not exposed to pi)":
    "标记为代理 profile（不参与故障转移、不暴露给 pi）",
  "add model id + Enter": "添加模型 ID + Enter",
  "Fetching…": "获取中…",
  "Fetch from provider": "从 provider 获取",
  "Checked = exposed to pi as": "勾选 = 暴露给 pi，形式为",
  "No models. Add ids above or fetch from the provider.": "无模型。请在上方添加 ID 或从 provider 获取。",
  remove: "移除",
  "expose all": "全部暴露",
  "expose none": "全部不暴露",
  "Models saved": "模型已保存",
  "Package spec is required": "请输入包 spec",
};

export function tr(lang: Lang, key: string): string {
  return lang === "zh" ? (zh[key] ?? key) : key;
}

type I18nCtx = {
  lang: Lang;
  setLang: (l: Lang) => void;
};
const Ctx = createContext<I18nCtx>({ lang: "en", setLang: () => {} });

export function LanguageProvider({
  configLang,
  children,
}: {
  configLang?: string | null;
  children: ReactNode;
}) {
  const [lang, setLang] = useState<Lang>(() => {
    if (configLang === "zh") return "zh";
    if (configLang === "en") return "en";
    return navigator.language.startsWith("zh") ? "zh" : "en";
  });
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (!manual && (configLang === "zh" || configLang === "en")) {
      setLang(configLang === "zh" ? "zh" : "en");
    }
  }, [configLang, manual]);

  const setLangCtx = (l: Lang) => {
    setManual(true);
    setLang(l);
  };

  return <Ctx.Provider value={{ lang, setLang: setLangCtx }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const { lang, setLang } = useContext(Ctx);
  return { lang, setLang, t: (k: string) => tr(lang, k) };
}
