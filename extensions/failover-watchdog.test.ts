import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRecoveryLine,
  selectNewEvents,
  latestEventTs,
  isForkedProcess,
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
  });
});

test("parseRecoveryLine tolerates a missing chain", () => {
  const event = parseRecoveryLine('{"ts": 1, "provider": "aihub"}');
  assert.deepEqual(event, { ts: 1, provider: "aihub", chain: undefined });
});

test("parseRecoveryLine rejects empty, invalid JSON and wrong shapes", () => {
  assert.equal(parseRecoveryLine(""), null);
  assert.equal(parseRecoveryLine("   "), null);
  assert.equal(parseRecoveryLine("not json"), null);
  assert.equal(parseRecoveryLine('{"ts": "x", "provider": "a"}'), null); // ts 非数字
  assert.equal(parseRecoveryLine('{"ts": 1}'), null); // 缺 provider
  assert.equal(parseRecoveryLine("null"), null);
  // chain 中的非字符串成员被过滤而非拒绝
  assert.deepEqual(parseRecoveryLine('{"ts": 1, "provider": "a", "chain": [1, 2]}'), {
    ts: 1,
    provider: "a",
    chain: [],
  });
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
