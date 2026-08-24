import { redact } from "./redact";
import { estimateCostUsd, ratesForModel } from "./pricing";
import type { PromptAnalysis, PromptComplexity } from "../shared/schemas";

type Candidate = { model: string; provider?: string; inputPerMtok?: number };

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const hasAny = (text: string, words: string[]) => words.some((word) => text.includes(word));

function complexity(text: string, metadata: { toolCount?: number; tokenInput?: number } = {}) {
  const lower = text.toLowerCase();
  const tokenEstimate = Math.ceil(text.length / 4);
  const dimensions = [
    { name: "context size", score: clamp(Math.min(100, tokenEstimate / 35)), evidence: `${tokenEstimate.toLocaleString()} estimated prompt tokens` },
    { name: "reasoning depth", score: hasAny(lower, ["why", "trade-off", "tradeoff", "compare", "design", "debug", "root cause", "prove", "architecture"]) ? 72 : 24, evidence: hasAny(lower, ["why", "trade-off", "tradeoff", "compare", "design", "debug", "root cause", "prove", "architecture"]) ? "requires analysis or tradeoff reasoning" : "no explicit multi-step reasoning signal" },
    { name: "tool orchestration", score: metadata.toolCount ? clamp(35 + metadata.toolCount * 12) : hasAny(lower, ["run ", "execute", "terminal", "browser", "inspect", "edit files", "implement"]) ? 58 : 12, evidence: metadata.toolCount ? `${metadata.toolCount} recorded tool calls` : hasAny(lower, ["run ", "execute", "terminal", "browser", "inspect", "edit files", "implement"]) ? "requests operational or code actions" : "no tool-use signal" },
    { name: "code-change scope", score: hasAny(lower, ["refactor", "migrate", "implement", "build", "repository", "codebase", "across files"]) ? 68 : hasAny(lower, ["fix", "function", "test", "bug"]) ? 42 : 8, evidence: hasAny(lower, ["refactor", "migrate", "implement", "build", "repository", "codebase", "across files"]) ? "mentions multi-file or implementation scope" : hasAny(lower, ["fix", "function", "test", "bug"]) ? "mentions a bounded code task" : "no code-change signal" },
    { name: "reliability risk", score: hasAny(lower, ["production", "security", "secret", "migration", "delete", "financial", "medical", "irreversible"]) ? 82 : 20, evidence: hasAny(lower, ["production", "security", "secret", "migration", "delete", "financial", "medical", "irreversible"]) ? "contains high-consequence or safety-sensitive terms" : "no high-consequence signal" },
    { name: "latency sensitivity", score: hasAny(lower, ["urgent", "quickly", "fast", "real-time", "latency", "interactive"]) ? 72 : 28, evidence: hasAny(lower, ["urgent", "quickly", "fast", "real-time", "latency", "interactive"]) ? "asks for low-latency handling" : "latency requirement is unspecified" },
  ];
  const score = clamp(dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length);
  const level: PromptComplexity = score >= 67 ? "high" : score >= 34 ? "medium" : "low";
  const requiredCapabilities = [
    dimensions[1].score >= 60 ? "deep reasoning" : "basic reasoning",
    dimensions[2].score >= 55 ? "tool use" : null,
    dimensions[3].score >= 55 ? "code generation" : null,
    dimensions[4].score >= 65 ? "high reliability" : null,
    dimensions[5].score >= 65 ? "low latency" : null,
  ].filter((value): value is string => Boolean(value));
  const unknowns = [
    tokenEstimate < 20 ? "prompt context is too short for a confident estimate" : null,
    dimensions[5].score === 28 ? "latency target is unspecified" : null,
    metadata.toolCount == null ? "tool history is unavailable" : null,
  ].filter((value): value is string => Boolean(value));
  const warnings = dimensions[1].score >= 60 && dimensions[5].score >= 65
    ? ["Deep reasoning and low latency can conflict; a fast model may trade answer quality for response time."]
    : [];
  return { dimensions, score, level, requiredCapabilities, unknowns, warnings };
}

function modelFit(model: string, analysis: ReturnType<typeof complexity>) {
  const lower = model.toLowerCase();
  const reasons: string[] = [];
  let fit = 50;
  if (analysis.requiredCapabilities.includes("deep reasoning")) {
    if (hasAny(lower, ["opus", "gpt-5", "reason", "qwen3"])) { fit += 25; reasons.push("strong reasoning family"); }
    else { fit -= 18; reasons.push("reasoning capability is uncertain"); }
  }
  if (analysis.requiredCapabilities.includes("code generation")) {
    if (hasAny(lower, ["codex", "coder", "code", "deepseek"])) { fit += 20; reasons.push("code-oriented model"); }
    else reasons.push("code specialization is not confirmed");
  }
  if (analysis.requiredCapabilities.includes("low latency") && hasAny(lower, ["haiku", "flash", "mini", "small", "7b"])) { fit += 15; reasons.push("smaller/fast model family"); }
  if (analysis.requiredCapabilities.includes("high reliability") && hasAny(lower, ["opus", "gpt-5", "sonnet"])) { fit += 12; reasons.push("reliability-oriented tier"); }
  if (hasAny(lower, ["haiku", "flash", "mini", "small", "7b"]) && analysis.level === "high") { fit -= 20; reasons.push("may underperform on high-complexity work"); }
  return { fit: clamp(fit), rationale: reasons.join("; ") || "capability evidence is limited" };
}

export function analyzePrompt(prompt: string, candidates: Candidate[], source: "prompt" | "session" = "prompt", metadata: { toolCount?: number; tokenInput?: number } = {}): PromptAnalysis {
  const redactedPrompt = redact(prompt);
  const analysis = complexity(redactedPrompt, metadata);
  const recommendations = candidates
    .filter((candidate) => candidate.model.trim())
    .map((candidate) => {
      const result = modelFit(candidate.model, analysis);
      const rates = ratesForModel(candidate.model)?.rates;
      const estimatedCostUsd = rates ? estimateCostUsd(rates, { input: Math.max(1, metadata.tokenInput ?? Math.ceil(redactedPrompt.length / 4)), output: Math.max(1, Math.ceil(redactedPrompt.length / 12)), cacheRead: 0 }) : null;
      const lower = candidate.model.toLowerCase();
      const estimatedLatencyMs = hasAny(lower, ["haiku", "flash", "mini", "small", "7b"]) ? 900 : hasAny(lower, ["opus", "gpt-5", "70b"]) ? 3200 : rates ? 1800 : null;
      return { model: candidate.model, provider: candidate.provider ?? null, fit: result.fit, rationale: result.rationale, estimatedCostUsd, estimatedLatencyMs };
    })
    .sort((a, b) => b.fit - a.fit || a.model.localeCompare(b.model))
    .slice(0, 3)
    .map((item, index) => ({ ...item, fit: index === 0 ? "recommended" as const : index === 1 ? "fallback" as const : "caution" as const, confidence: item.fit >= 75 ? "high" as const : item.fit >= 55 ? "medium" as const : "low" as const }));
  return { redactedPrompt, complexity: analysis.level, score: analysis.score, dimensions: analysis.dimensions, requiredCapabilities: analysis.requiredCapabilities, unknowns: analysis.unknowns, warnings: analysis.warnings, recommendations, source, analyzedAt: new Date().toISOString() };
}
