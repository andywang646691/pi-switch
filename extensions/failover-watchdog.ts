/**
 * pi-switch 恢复事件 → pi continue 桥接 (failover watchdog)
 *
 * 职责单一: 内核 (Rust 代理进程) 负责监测上游熔断、探测恢复、让节点退出熔断,
 * 并把每次节点恢复追加为一行 JSON 到 ~/.pi-switch/recovery.jsonl (事件携带
 * 故障期间失败过的会话 id)。
 * 本扩展只做一件事: 轮询该文件, 发现与本会话相关的新恢复事件后,**检查 agent
 * 是否已把控制权交还给用户** (会话空闲、LLM 不在输出、无排队消息、输入框可用),
 * 只有确认用户可输入时, 才以 user 身份向 pi 发送一条 "continue" 消息让 pi
 * 重试被中断的任务。若 agent 仍在工作, 事件挂起、下一轮再查, 绝不把 continue
 * 排到当前输出结束后投递 (那会在 agent 刚交还控制权时抢走输入)。其他 agent
 * 造成的故障 (事件里没有本会话 id) 不会触发 continue; 多个 pi 实例也互不打扰。
 *
 * 无 slash 命令、无配置文件、不触碰 circuit.json。
 *
 * 开销与隔离:
 *  - 每 3s 读一次小文件, I/O/CPU 可忽略; 定时器 unref, 不阻止进程退出。
 *  - subagent / Magic Context 后台进程不加载轮询逻辑 (各自会话无关)。
 */

/** 会话分支条目里与「用户是否已继续会话」判断相关的字段。 */
export type BranchStateEntry = {
  type: string;
  timestamp: string;
  message?: { role?: string };
};

/**
 * 判断 agent 是否已把控制权交还给用户:
 *  - ctx.isIdle(): 会话空闲 —— 没有运行中的 agent run / 自动重试 / 自动压缩
 *    重试 / 排队续跑; LLM 输出中 (streaming) 也属于 agent run, 视为未交还;
 *  - !ctx.hasPendingMessages(): 没有排队等待投递的 steer/followUp 消息,
 *    否则会话马上会自行继续, 再发 continue 只会重复打扰;
 * 拿不到上下文时一律视为未交还 (安全侧: 宁可不下发, 不打扰用户)。
 */
export function userHasControl(
  ctx: { isIdle(): boolean; hasPendingMessages(): boolean } | undefined,
): boolean {
  if (!ctx) return false;
  return ctx.isIdle() && !ctx.hasPendingMessages();
}

/**
 * 分支中是否存在时间戳晚于 afterTs 的用户消息 (即故障之后用户已亲自继续了会话)。
 * 从分支尾部往前找最后一条 user 消息: 它晚于 afterTs 则返回 true;
 * 不晚于 (或无法解析) 则其之前不可能再有更新的用户消息, 返回 false。
 */
export function hasUserMessageAfter(
  branch: readonly BranchStateEntry[],
  afterTs: number,
): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts)) return false;
    return ts > afterTs;
  }
  return false;
}

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
  /**
   * 故障期间请求失败过的会话 id (x-conversation-id)。只有出现在这里的
   * pi 会话才会在恢复后收到 continue —— 非 pi 客户端 (curl、其他 agent)
   * 的请求不携带会话标识, 不会出现在列表中, 因此它们的故障不会触发
   * 任何会话的 continue。缺失该字段 (旧版代理写入的事件) 视为未知,
   * 同样不触发。
   */
  conversations?: string[];
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
    const { ts, provider, chain, conversations } = obj as {
      ts?: unknown;
      provider?: unknown;
      chain?: unknown;
      conversations?: unknown;
    };
    if (typeof ts !== "number" || typeof provider !== "string") return null;
    return {
      ts,
      provider,
      chain: Array.isArray(chain) ? chain.filter((c): c is string => typeof c === "string") : undefined,
      conversations: Array.isArray(conversations)
        ? conversations.filter((c): c is string => typeof c === "string")
        : undefined,
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

/**
 * 只保留与本会话相关的事件: 事件声明的 conversations 必须包含当前会话 id。
 * 拿不到自己的会话 id, 或事件缺失 conversations (旧版代理/非 pi 故障),
 * 一律视为与本会话无关, 不触发 continue。
 */
export function eventsForConversation(
  events: RecoveryEvent[],
  conversationId: string | undefined,
): RecoveryEvent[] {
  if (!conversationId) return [];
  return events.filter((e) => (e.conversations ?? []).includes(conversationId));
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

    // 只响应与本会话相关的事件: 其他 agent 造成的故障恢复不会打扰本会话,
    // 多个 pi 实例也各自只收到与自己相关的事件。
    const ownId = latestCtx?.sessionManager?.getSessionId?.();
    const mine = eventsForConversation(events, ownId);
    // 非本会话的事件直接消费掉 (游标越过), 避免每轮重复扫描同一批事件。
    if (mine.length === 0) {
      cursorTs = latestEventTs(events);
      return;
    }
    const recoveryTs = latestEventTs(mine);

    // 故障之后用户是否已经发出新消息 (用户手动重试了任务, 或另一个扩展接管了
    // 输入并把消息写成了 user 角色): 会话已经自行继续, 恢复信号已过期,
    // 直接消费事件, 不发送 continue, 避免打扰用户正在进行的对话。
    if (latestCtx && hasUserMessageAfter(latestCtx.sessionManager.getBranch(), recoveryTs)) {
      cursorTs = recoveryTs;
      return;
    }

    // 只在 agent 把控制权交还给用户时才发送 continue (见 userHasControl):
    // 会话空闲 + 无排队消息 + 用户可输入。忙时事件挂起、下一轮再查 ——
    // 绝不把 continue 排到当前输出结束后投递。
    if (!userHasControl(latestCtx)) return;

    sending = true;
    try {
      // 此时已确认空闲: 普通发送立即触发新一轮, 无需 deliverAs。
      await pi.sendUserMessage(CONTINUE_MESSAGE);
      // 同一轮内多个节点恢复合并为一条 continue; 发送成功才推进游标,
      // 失败则下一轮重试 (事件不会丢失)。
      cursorTs = recoveryTs;
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
