const rules: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]"],
  [/\b(?:sk|pk|rk)-(?:live-|test-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED API KEY]"],
  [/\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g, "[REDACTED TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]"],
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s'\"]+)/g, "$1=[REDACTED]"],
  [/(https?:\/\/[^\s:/@]+:)[^\s@]+@/gi, "$1[REDACTED]@"]
];

export function redact(input: unknown): string {
  let value = typeof input === "string" ? input : JSON.stringify(input ?? "");
  if (/^(?:data:.*;base64,|[A-Za-z0-9+/]{200,}={0,2}$)/s.test(value.trim())) return "[BINARY PAYLOAD OMITTED]";
  for (const [pattern, replacement] of rules) value = value.replace(pattern, replacement);
  return value.slice(0, 250_000);
}
