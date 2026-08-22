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
});
