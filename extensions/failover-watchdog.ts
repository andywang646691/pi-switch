/**
 * pi-switch 恢复事件 → pi continue 桥接 (failover watchdog)
 *
 * 职责单一: 内核 (Rust 代理进程) 负责监测上游熔断、探测恢复、让节点退出熔断,
 * 并把每次节点恢复追加为一行 JSON 到 ~/.pi-switch/recovery.jsonl。
 * 本扩展只做一件事: 轮询该文件, 发现新恢复事件后以 user 身份向 pi 发送
 * 一条 "continue" 消息, 让 pi 重试被中断的任务。
 *
 * 无 slash 命令、无配置文件、不触碰 circuit.json。
 *
 * 开销与隔离:
 *  - 每 3s 读一次小文件, I/O/CPU 可忽略; 定时器 unref, 不阻止进程退出。
 *  - subagent / Magic Context 后台进程不加载轮询逻辑 (各自会话无关)。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const RECOVERY_LOG_PATH = join(homedir(), ".pi-switch", "recovery.jsonl");
export const POLL_INTERVAL_MS = 3000;
export const CONTINUE_MESSAGE = "continue";

export type RecoveryEvent = {
  ts: number;
  provider: string;
  chain?: string[];
};

/**
 * 是否为与主会话无关的派生进程:
 *  - subagent (PI_SUBAGENT_DEPTH >= 1): 独立会话, 恢复事件与它无关;
 *  - Magic Context 后台进程 (MAGIC_CONTEXT_PI_SUBAGENT=1): ephemeral, 无会话。
 * 这类进程不应轮询事件或发送 continue。
 */
export function isForkedProcess(env: Record<string, string | undefined> = process.env): boolean {
  const depth = Number.parseInt(env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
  if (depth >= 1) return true;
  return env.MAGIC_CONTEXT_PI_SUBAGENT === "1";
}

/** 解析 recovery.jsonl 的一行; 非 JSON / 缺 ts / 缺 provider 视为无效。 */
export function parseRecoveryLine(line: string): RecoveryEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (typeof obj !== "object" || obj === null) return null;
    const { ts, provider, chain } = obj as { ts?: unknown; provider?: unknown; chain?: unknown };
    if (typeof ts !== "number" || typeof provider !== "string") return null;
    return {
      ts,
      provider,
      chain: Array.isArray(chain) ? chain.filter((c): c is string => typeof c === "string") : undefined,
    };
  } catch {
    return null;
  }
}

/** 从文件全文里挑出 ts 大于游标的新事件, 按 ts 升序。 */
export function selectNewEvents(text: string, cursorTs: number): RecoveryEvent[] {
  const events: RecoveryEvent[] = [];
  for (const line of text.split("\n")) {
    const event = parseRecoveryLine(line);
    if (event && event.ts > cursorTs) events.push(event);
  }
  return events.sort((a, b) => a.ts - b.ts);
}

/** 一组事件里的最大 ts (无事件时为 0)。 */
export function latestEventTs(events: RecoveryEvent[]): number {
  return events.reduce((max, e) => Math.max(max, e.ts), 0);
}

export default function failoverWatchdogExtension(pi: ExtensionAPI): void {
  // subagent / Magic Context 后台进程: 事件与这些独立会话无关, 跳过加载。
  if (isForkedProcess()) return;

  let cursorTs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let latestCtx: ExtensionContext | undefined;
  let sending = false;

  /** 会话启动时把游标初始化到文件当前尾部, 之前的历史事件不再重复触发。 */
  async function initializeCursor(): Promise<void> {
    try {
      const text = await readFile(RECOVERY_LOG_PATH, "utf8");
      cursorTs = latestEventTs(selectNewEvents(text, 0));
    } catch {
      cursorTs = 0; // 文件尚不存在
    }
  }

  async function checkRecoveries(): Promise<void> {
    if (sending) return; // 上一次发送尚未结束, 事件留到下一轮
    let text: string;
    try {
      text = await readFile(RECOVERY_LOG_PATH, "utf8");
    } catch {
      return; // 文件尚不存在
    }
    const events = selectNewEvents(text, cursorTs);
    if (events.length === 0) return;

    sending = true;
    try {
      if (latestCtx?.isIdle()) {
        await pi.sendUserMessage(CONTINUE_MESSAGE);
      } else {
        await pi.sendUserMessage(CONTINUE_MESSAGE, { deliverAs: "followUp" });
      }
      // 同一轮内多个节点恢复合并为一条 continue; 发送成功才推进游标,
      // 失败则下一轮重试 (事件不会丢失)。
      cursorTs = latestEventTs(events);
    } catch {
      // 发送失败: 游标不动, 下一轮重试
    } finally {
      sending = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    await initializeCursor();
    if (timer == null) {
      timer = setInterval(() => {
        checkRecoveries().catch(() => {});
      }, POLL_INTERVAL_MS);
      // unref: 轮询不应阻止 pi 进程退出 (如 -p 一次性模式)。
      // TUI/RPC 下进程有其他句柄, unref 不影响定时器照常触发。
      timer.unref();
    }
  });

  pi.on("session_shutdown", () => {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    latestCtx = undefined;
    sending = false;
  });
}
