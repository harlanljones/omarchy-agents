import { describe, expect, test } from "bun:test";
import { rank } from "../src/server/ranking";

const records:any[] = [
  { id:"codex", name:"Codex", todayTotalTokens:100, recentDays:[{date:"2026-08-22",messageCount:100}], modelUsage:{gpt:{inputTokens:80,outputTokens:20}} },
  { id:"claude", name:"Claude", todayTotalTokens:100, recentDays:[{date:"2026-08-22",messageCount:100}], modelUsage:{opus:{inputTokens:60,outputTokens:40}} },
  { id:"unknown", name:"Unknown", todayTotalTokens:0, recentDays:[] }
];
describe("desktop-compatible ranking", () => {
  test("ties share rank and sort by name", () => { const result=rank(records,"today"); expect(result.rows.map(r=>[r.providerName,r.rank])).toEqual([["Claude",1],["Codex",1]]); });
  test("all-time sums model token buckets", () => expect(rank(records,"all").total).toBe(200));
  test("omits zero-use providers", () => expect(rank(records,"week").rows).toHaveLength(2));
  test("coverage is derived from the provider registry", () => {
    const withCline = [...records, { id: "cline", name: "Cline", todayTotalTokens: 50, recentDays: [{ date: "2026-08-22", messageCount: 50 }], modelUsage: { deep: { inputTokens: 40, outputTokens: 10 } } }];
    const clineRow = rank(withCline, "today").rows.find(r => r.providerId === "cline")!;
    expect(clineRow.coverage).toBe("indexed");
    const fireworks = rank([{ id: "fireworks", name: "Fireworks", todayTotalTokens: 50, recentDays: [{ date: "2026-08-22", messageCount: 50 }] }], "today").rows[0];
    expect(fireworks.coverage).toBe("metrics-only");
  });
  test("computes estimated spending per row and total spending", () => {
    const pricedRecords = [
      {
        id: "claude",
        name: "Claude",
        todayTotalTokens: 1_000_000,
        recentDays: [{ date: "2026-08-22", messageCount: 1_000_000 }],
        modelUsage: {
          "claude-sonnet-4": { inputTokens: 800_000, outputTokens: 200_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
        }
      }
    ];
    const res = rank(pricedRecords, "all");
    expect(res.rows[0].estCostUsd).toBeCloseTo((800_000 * 3 + 200_000 * 15) / 1e6);
    expect(res.totalCostUsd).toBeCloseTo((800_000 * 3 + 200_000 * 15) / 1e6);
  });
});
