import assert from "node:assert/strict";
import test from "node:test";
import { formatFightTimestamp, parseFFLogsUrl } from "./fflogs.ts";

test("parses a numbered FF Logs fight URL", () => {
  assert.deepEqual(
    parseFFLogsUrl("https://www.fflogs.com/reports/bLHFCQWpGvyNz8J7?fight=24"),
    {
      url: "https://www.fflogs.com/reports/bLHFCQWpGvyNz8J7?fight=24",
      reportCode: "bLHFCQWpGvyNz8J7",
      fightId: 24,
    }
  );
});

test("accepts localized FF Logs hosts and removes fragments", () => {
  assert.deepEqual(
    parseFFLogsUrl("https://ja.fflogs.com/reports/abc123/?fight=7#type=debuffs"),
    {
      url: "https://ja.fflogs.com/reports/abc123/?fight=7",
      reportCode: "abc123",
      fightId: 7,
    }
  );
});

test("rejects non-FF Logs and non-numbered fight links", () => {
  assert.throws(() => parseFFLogsUrl("https://example.com/reports/abc?fight=1"), /fflogs\.com/);
  assert.throws(() => parseFFLogsUrl("https://www.fflogs.com/reports/abc?fight=last"), /numbered fight/);
});

test("formats fight-relative timestamps without losing milliseconds", () => {
  assert.equal(formatFightTimestamp(0), "00:00.000");
  assert.equal(formatFightTimestamp(125_678), "02:05.678");
});
