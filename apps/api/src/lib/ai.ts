import { env } from "../env";

/**
 * WindVeal AI talks to a model through the standard "chat completions" format with tools. Ollama,
 * llama.cpp's server, vLLM and most other ways of hosting an open model offer it, so the model can be
 * swapped without touching the app. Set AI_BASE_URL (e.g. http://localhost:11434/v1 for Ollama) and
 * AI_MODEL; until then WindVeal AI reports that it isn't connected and the rest of WindVeal works as normal.
 */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export const aiConnected = () => !!env.aiBaseUrl && !!env.aiModel;

export class AiUnavailable extends Error {}

export async function chatCompletion(messages: ChatMessage[], tools: ToolSpec[]): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
  if (!aiConnected()) throw new AiUnavailable("Veal isn't connected yet.");
  let res: Response;
  try {
    res = await fetch(`${env.aiBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(env.aiApiKey ? { Authorization: `Bearer ${env.aiApiKey}` } : {}) },
      // No tools (e.g. reading a spreadsheet): a plain question and answer.
      body: JSON.stringify({ model: env.aiModel, messages, ...(tools.length ? { tools, tool_choice: "auto" } : {}), temperature: 0.1, stream: false, ...env.aiExtraBody }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new AiUnavailable("Veal isn't answering right now. Try again in a moment.");
  }
  if (!res.ok) throw new AiUnavailable(`Veal couldn't answer (${res.status}).`);
  const body = await res.json() as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
  const m = body.choices?.[0]?.message;
  return { content: m?.content ?? null, toolCalls: (m?.tool_calls ?? []).map((t, i) => ({ ...t, id: t.id || `call_${i}`, type: "function" })) };
}
