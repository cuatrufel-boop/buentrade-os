// Thin Anthropic Structured-Outputs call (same endpoint/beta/model as _shared/llmExtractor.ts).
// Used ONLY for the narrative text of the bulletin — never for numbers in tables (those are parsed
// deterministically). Injected into narrative.ts so the verification logic stays testable offline.
export type LlmCall = (system: string, user: string, schema: Record<string, unknown>, maxTokens?: number) => Promise<any>;

export const callClaude: LlmCall = async (system, user, schema, maxTokens = 4096) => {
  const key = (globalThis as any).Deno?.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "structured-outputs-2025-11-13" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }], output_format: { type: "json_schema", schema } }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic API failed: ${JSON.stringify(data)}`);
  const block = (data.content || []).find((b: any) => b.type === "text");
  if (!block) throw new Error(`No text content in Anthropic response: ${JSON.stringify(data)}`);
  return JSON.parse(block.text);
};
