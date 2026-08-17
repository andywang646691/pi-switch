import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRecoveryLine,
  selectNewEvents,
  latestEventTs,
  eventsForConversation,
  isForkedProcess,
  userHasControl,
  hasUserMessageAfter,
  CONTINUE_MESSAGE,
  POLL_INTERVAL_MS,
} from "./failover-watchdog.ts";

test("parseRecoveryLine parses a valid recovery event", () => {
  const event = parseRecoveryLine(
    '{"ts": 1786466000000, "provider": "congee", "chain": ["congee"]}',
  );
  assert.deepEqual(event, {
    ts: 1786466000000,
    provider: "congee",
    chain: ["congee"],
    conversations: undefined,
  });
});

test("parseRecoveryLine parses affected conversations", () => {
  const event = parseRecoveryLine(
    '{"ts": 1, "provider": "congee", "conversations": ["sess-a", "sess-b"]}',
  );
  assert.deepEqual(event, {
    ts: 1,
    provider: "congee",
    chain: undefined,
    conversations: ["sess-a", "sess-b"],
  });
});

test("parseRecoveryLine tolerates a missing chain", () => {
  const event = parseRecoveryLine('{"ts": 1, "provider": "aihub"}');
  assert.deepEqual(event, { ts: 1, provider: "aihub", chain: undefined, conversations: undefined });
});

test("parseRecoveryLine rejects empty, invalid JSON and wrong shapes", () => {
  assert.equal(parseRecoveryLine(""), null);
  assert.equal(parseRecoveryLine("   "), null);
  assert.equal(parseRecoveryLine("not json"), null);
  assert.equal(parseRecoveryLine('{"ts": "x", "provider": "a"}'), null); // ts 非数字
  assert.equal(parseRecoveryLine('{"ts": 1}'), null); // 缺 provider
  assert.equal(parseRecoveryLine("null"), null);
  // chain / conversations 中的非字符串成员被过滤而非拒绝
  assert.deepEqual(parseRecoveryLine('{"ts": 1, "provider": "a", "chain": [1, 2]}'), {
    ts: 1,
    provider: "a",
    chain: [],
    conversations: undefined,
  });
  assert.deepEqual(
    parseRecoveryLine('{"ts": 1, "provider": "a", "conversations": [1, "sess-x"]}'),
    { ts: 1, provider: "a", chain: undefined, conversations: ["sess-x"] },
  );
});

test("selectNewEvents returns only events newer than the cursor, sorted", () => {
  const text = [
    '{"ts": 100, "provider": "a"}',
    '{"ts": 300, "provider": "c"}',
    "garbage line",
    '{"ts": 200, "provider": "b"}',
    "",
  ].join("\n");
  const events = selectNewEvents(text, 100);
  assert.deepEqual(
    events.map((e) => [e.ts, e.provider]),
    [
      [200, "b"],
      [300, "c"],
    ],
  );
  // 恰好等于游标的事件不算新
  assert.equal(selectNewEvents(text, 300).length, 0);
});

test("selectNewEvents strictly requires ts > cursor", () => {
  const text = '{"ts": 100, "provider": "a"}\n{"ts": 50, "provider": "old"}';
  // 游标 100: ts=100 的事件与游标相等, 不算新
  assert.deepEqual(selectNewEvents(text, 100).map((e) => e.provider), []);
  // 游标 99: ts=100 才算新, ts=50 仍被忽略
  assert.deepEqual(selectNewEvents(text, 99).map((e) => e.provider), ["a"]);
});

test("latestEventTs returns max ts and 0 for no events", () => {
  assert.equal(
    latestEventTs([
      { ts: 10, provider: "a" },
      { ts: 99, provider: "b" },
    ]),
    99,
  );
  assert.equal(latestEventTs([]), 0);
});

test("eventsForConversation only matches events naming this session", () => {
  const mine = { ts: 1, provider: "a", conversations: ["sess-pi"] };
  const others = { ts: 2, provider: "b", conversations: ["sess-other"] };
  const legacy = { ts: 3, provider: "c" }; // 旧版代理事件, 无 conversations
  const empty = { ts: 4, provider: "d", conversations: [] }; // 非 pi 客户端造成的故障

  assert.deepEqual(eventsForConversation([mine, others, legacy, empty], "sess-pi"), [mine]);
  // 其他会话的事件不命中
  assert.deepEqual(eventsForConversation([mine, others, legacy, empty], "sess-other"), [others]);
  // 拿不到自己的会话 id 时不发送任何 continue
  assert.deepEqual(eventsForConversation([mine, others, legacy, empty], undefined), []);
  // 事件缺失 conversations (旧版) 或为空 (非 pi 故障) 一律不命中
  assert.deepEqual(eventsForConversation([legacy, empty], "sess-pi"), []);
});

test("eventsForConversation handles blank session id", () => {
  const mine = { ts: 1, provider: "a", conversations: ["sess-pi"] };
  assert.deepEqual(eventsForConversation([mine], ""), []);
});

test("userHasControl gates on idle and no pending messages", () => {
  const idle = { isIdle: () => true, hasPendingMessages: () => false };
  const busy = { isIdle: () => false, hasPendingMessages: () => false };
  const pending = { isIdle: () => true, hasPendingMessages: () => true };
  const busyPending = { isIdle: () => false, hasPendingMessages: () => true };

  assert.equal(userHasControl(idle), true);
  assert.equal(userHasControl(busy), false); // agent 仍在工作 / LLM 输出中
  assert.equal(userHasControl(pending), false); // 有排队消息, 会话会自行继续
  assert.equal(userHasControl(busyPending), false);
  assert.equal(userHasControl(undefined), false); // 拿不到上下文: 安全侧, 不发
});

test("hasUserMessageAfter detects user taking over after a recovery event", () => {
  const before = "2026-01-01T00:00:00.000Z"; // ts = 1767225600000
  const after = "2026-01-01T00:00:05.000Z"; // ts = 1767225605000
  const userAfter = {
    type: "message",
    timestamp: after,
    message: { role: "user" },
  };
  const userBefore = {
    type: "message",
    timestamp: before,
    message: { role: "user" },
  };
  const assistantAfter = {
    type: "message",
    timestamp: after,
    message: { role: "assistant" },
  };
  const customAfter = { type: "custom", timestamp: after, customType: "x" };

  // 故障 (ts=1767225603000) 之后用户发了新消息 → 信号过期
  assert.equal(hasUserMessageAfter([userBefore, userAfter], 1767225603000), true);
  // 最后一条用户消息在故障之前 → 未接手
  assert.equal(hasUserMessageAfter([userBefore, assistantAfter], 1767225603000), false);
  // 故障之后只有 assistant 输出 / custom 条目 → 未接手
  assert.equal(hasUserMessageAfter([userBefore, assistantAfter, customAfter], 1767225603000), false);
  // 空分支
  assert.equal(hasUserMessageAfter([], 1767225603000), false);
  // 全无 user 消息
  assert.equal(hasUserMessageAfter([assistantAfter, customAfter], 1767225603000), false);
});

test("hasUserMessageAfter treats equal/unparseable timestamps as not-after", () => {
  const equalTs = "2026-01-01T00:00:03.000Z"; // 恰等于事件 ts
  const userEqual = { type: "message", timestamp: equalTs, message: { role: "user" } };
  const userBad = { type: "message", timestamp: "not-a-date", message: { role: "user" } };

  assert.equal(hasUserMessageAfter([userEqual], 1767225603000), false);
  assert.equal(hasUserMessageAfter([userBad], 1767225603000), false);
});

test("extension constants are the documented values", () => {
  assert.equal(CONTINUE_MESSAGE, "continue");
  assert.equal(POLL_INTERVAL_MS, 3000);
});

test("isForkedProcess skips subagents and Magic Context background processes", () => {
  assert.equal(isForkedProcess({}), false);
  assert.equal(isForkedProcess({ PI_SUBAGENT_DEPTH: "0" }), false);
  assert.equal(isForkedProcess({ PI_SUBAGENT_DEPTH: "1" }), true);
  assert.equal(isForkedProcess({ PI_SUBAGENT_DEPTH: "2" }), true);
  assert.equal(isForkedProcess({ PI_SUBAGENT_DEPTH: "junk" }), false);
  assert.equal(isForkedProcess({ MAGIC_CONTEXT_PI_SUBAGENT: "1" }), true);
  assert.equal(
    isForkedProcess({ PI_SUBAGENT_DEPTH: "0", MAGIC_CONTEXT_PI_SUBAGENT: "0" }),
    false,
  );
});
