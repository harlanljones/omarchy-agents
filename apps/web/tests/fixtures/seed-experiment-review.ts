import { db } from "../../src/server/db";
import { createExperimentService } from "../../src/server/experiments";
import { seedSession, seedSuggestion } from "../helpers/experiment-db";

db.run("DELETE FROM experiment_reviews");
db.run("DELETE FROM experiment_sessions");
db.run("DELETE FROM experiments");
db.run("DELETE FROM suggestions");
db.run("DELETE FROM reports");
db.run("DELETE FROM sessions");
const baseline = [
  ["b_9f4a2d6c", "claude", 312884, 58, 312], ["b_2c8e7f19", "opencode", 298431, 51, 298],
  ["b_4a1b3e77", "antigravity", 326119, 66, 327], ["b_7d3f8a51", "codex", 308178, 47, 307],
] as const;
const trial = [
  ["t_1a6c4d91", "claude", 301552, 18, 300], ["t_8b3e6f22", "opencode", 286347, 17, 288],
  ["t_5c7a1b90", "antigravity", 317960, 25, 316], ["t_2d9e4c73", "codex", 312024, 21, 313],
] as const;
const visualSessions = [...baseline, ...trial];
const visualDates = ["2026-08-24T09:14:00Z", "2026-08-25T10:05:00Z", "2026-08-26T13:41:00Z", "2026-08-27T11:32:00Z", "2026-08-28T09:09:00Z", "2026-08-28T15:27:00Z", "2026-08-29T10:12:00Z", "2026-08-30T11:18:00Z"];
for (const [index, [id, provider, tokens, errors, tools]] of visualSessions.entries()) {
  seedSession(db, id, { provider, startedAt: visualDates[index], endedAt: visualDates[index], input: tokens, output: 0, read: 0, write: 0, errors, tools, title: `${provider} retry session` });
}
const citations = visualSessions.map(([sessionId, provider], index) => {
  const eventId = `e_retry_${index + 1}`;
  const timestamp = visualDates[index];
  db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)").run(
    eventId, sessionId, 0, "error", timestamp, "Redacted tool retry failure", "tool", `session:${sessionId}`, "{}",
  );
  return { id: `ev_${eventId}`, provider, sessionId, anchor: "event", eventId, timestamp, excerpt: "Redacted tool retry failure" };
});
seedSuggestion(db, { evidence: JSON.stringify(citations) });
db.query("UPDATE reports SET detectors_json=? WHERE id='report-1'").run(JSON.stringify([{
  key: "failed_tools:codex", type: "failed_tools", provider: "codex", severity: "warning",
  message: "Review repeated tool retry behavior.", value: 0.18, evidence: citations,
}]));
const service = createExperimentService(db);
const created = service.createExperiment({
  suggestionId: "suggestion-1", hypothesis: "Reducing retry attempts from 3 to 1 lowers tool failure rate without increasing task abandonment.",
  metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: baseline.map(([id]) => id),
});
service.startExperiment(created.id);
service.replaceCohort(created.id, "trial", trial.map(([id]) => id));
service.markReadyForReview(created.id);
console.log(created.id);
