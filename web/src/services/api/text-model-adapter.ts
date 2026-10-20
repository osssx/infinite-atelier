import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import { proxyApiUrl } from "@/lib/api-proxy";

/** One provider-neutral model turn. Skill tools are dispatched by text-agent-runner. */
export type TextContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
export type TextToolSpec = { name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
export type TextToolCall = { id: string; name: string; argumentsJson: string; thoughtSignature?: string };
export type TextConversationItem =
    | { role: "system" | "user" | "assistant"; content: TextContent }
    | { role: "assistant"; content: string; toolCalls: TextToolCall[]; responseOutput?: unknown[]; geminiParts?: Record<string, unknown>[] }
    | { role: "tool"; callId: string; name: string; content: string };
export type TextTurnResult = { text: string; toolCalls: TextToolCall[]; responseOutput?: unknown[]; geminiParts?: Record<string, unknown>[] };
export type TextTurnInput = { config: AiConfig; messages: TextConversationItem[]; tools?: TextToolSpec[]; toolChoice?: "auto" | "required" | "none"; signal?: AbortSignal; onText?: (value: string) => void };

const unsupportedResponses = new Set<string>();
class TextHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const partsText = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v) ? v.map((p) => str(record(p).text)).join("") : "";
const throwAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); };
function history(input: TextTurnInput): TextConversationItem[] {
    return input.config.systemPrompt.trim() ? [{ role: "system", content: input.config.systemPrompt.trim() }, ...input.messages] : input.messages;
}
async function send(input: TextTurnInput, url: string, data: unknown, gemini = false) {
    throwAborted(input.signal);
    const response = await fetch(url, { method: "POST", signal: input.signal, headers: gemini ? { "Content-Type": "application/json", "x-goog-api-key": input.config.apiKey } : { "Content-Type": "application/json", Authorization: `Bearer ${input.config.apiKey}` }, body: JSON.stringify(data) });
    if (!response.ok) {
        const raw = await response.text();
        let detail = raw;
        try { detail = str(record(record(JSON.parse(raw)).error).message) || raw; } catch { /* text body */ }
        throw new TextHttpError(response.status, detail || `HTTP ${response.status}`);
    }
    return response;
}
/** Stream chunks need not align with SSE event lines or with tool arguments. */
async function parseStream(response: Response, signal: AbortSignal | undefined, onEvent: (event: Record<string, unknown>) => void) {
    if (!response.body) { onEvent(record(await response.json())); return; }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", raw = "", count = 0;
    const block = (value: string) => {
        const data = value.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
        if (!data || data === "[DONE]") return;
        count++; onEvent(record(JSON.parse(data)));
    };
    try {
        while (true) {
            throwAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk; raw += chunk;
            while (true) {
                const match = /\r?\n\r?\n/.exec(buffer);
                if (!match) break;
                block(buffer.slice(0, match.index));
                buffer = buffer.slice(match.index + match[0].length);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) block(buffer);
        if (!count && raw.trim()) onEvent(record(JSON.parse(raw)));
    } finally { reader.releaseLock(); }
}
function responseInput(item: TextConversationItem): unknown[] {
    if (item.role === "tool") return [{ type: "function_call_output", call_id: item.callId, output: item.content }];
    if ("toolCalls" in item) return item.responseOutput?.length ? item.responseOutput : [
        ...(item.content ? [{ role: "assistant", content: item.content }] : []),
        ...item.toolCalls.map((c) => ({ type: "function_call", call_id: c.id, name: c.name, arguments: c.argumentsJson })),
    ];
    return [{ role: item.role, content: typeof item.content === "string" ? item.content : item.content.map((p) => p.type === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: p.image_url.url }) }];
}
function parseResponseOutput(output: unknown[]): TextTurnResult {
    const toolCalls: TextToolCall[] = [];
    let text = "";
    for (const raw of output) {
        const item = record(raw);
        if (item.type === "function_call" && str(item.name) && str(item.call_id || item.id)) toolCalls.push({ id: str(item.call_id || item.id), name: str(item.name), argumentsJson: str(item.arguments) || "{}" });
        if (item.type === "message") text += partsText(item.content);
    }
    return { text, toolCalls, responseOutput: output };
}
async function responsesTurn(input: TextTurnInput): Promise<TextTurnResult> {
    const tools = input.tools || [];
    const response = await send(input, proxyApiUrl(buildApiUrl(input.config.baseUrl, "/responses")), {
        model: input.config.model, input: history(input).flatMap(responseInput), stream: true,
        ...(input.config.reasoningEffort === "auto" ? {} : { reasoning: { effort: input.config.reasoningEffort } }),
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function", ...t })), tool_choice: input.toolChoice || "auto" } : {}),
    });
    let text = "";
    let completed: Record<string, unknown> = {};
    const pending = new Map<number, { id: string; name: string; args: string }>();
    await parseStream(response, input.signal, (e) => {
        const type = str(e.type);
        if (type === "response.output_text.delta") { text += str(e.delta); input.onText?.(text); }
        if (type === "response.output_text.done" && !text) { text = str(e.text); input.onText?.(text); }
        if (type === "response.completed" && e.response) completed = record(e.response);
        if (Array.isArray(e.output)) completed = e;
        if (type === "error" || type === "response.failed") throw new Error(str(record(e.error).message) || "Responses stream failed");
        const idx = Number(e.output_index);
        if (!Number.isInteger(idx) || e.output_index === undefined) return;
        const prev = pending.get(idx) || { id: "", name: "", args: "" };
        const item = record(e.item);
        if ((type === "response.output_item.added" || type === "response.output_item.done") && item.type === "function_call") pending.set(idx, { id: str(item.call_id) || prev.id, name: str(item.name) || prev.name, args: str(item.arguments) || prev.args });
        if (type === "response.function_call_arguments.delta") pending.set(idx, { ...prev, args: prev.args + str(e.delta) });
        if (type === "response.function_call_arguments.done") pending.set(idx, { ...prev, args: str(e.arguments) });
    });
    if (record(completed.error).message) throw new Error(str(record(completed.error).message));
    const output = Array.isArray(completed.output) ? completed.output : undefined;
    const parsed = output ? parseResponseOutput(output) : { text: "", toolCalls: [] as TextToolCall[] };
    const toolCalls = parsed.toolCalls.length ? parsed.toolCalls : [...pending.entries()].sort(([a], [b]) => a - b).map(([, c]) => ({ id: c.id, name: c.name, argumentsJson: c.args || "{}" })).filter((c) => c.id && c.name);
    const finalText = text || str(completed.output_text) || parsed.text;
    if (!text && finalText) input.onText?.(finalText);
    return { text: finalText, toolCalls, ...(output ? { responseOutput: output } : {}) };
}
function chatInput(item: TextConversationItem) {
    if (item.role === "tool") return { role: "tool", tool_call_id: item.callId, content: item.content };
    if ("toolCalls" in item) return { role: "assistant", content: item.content || null, tool_calls: item.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argumentsJson } })) };
    return { role: item.role, content: item.content };
}
async function chatTurn(input: TextTurnInput): Promise<TextTurnResult> {
    const tools = input.tools || [];
    const response = await send(input, proxyApiUrl(buildApiUrl(input.config.baseUrl, "/chat/completions")), {
        model: input.config.model, messages: history(input).map(chatInput), stream: true,
        ...(input.config.reasoningEffort === "auto" ? {} : { reasoning_effort: input.config.reasoningEffort }),
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: input.toolChoice || "auto" } : {}),
    });
    let text = "";
    const calls = new Map<number, TextToolCall>();
    await parseStream(response, input.signal, (e) => {
        if (record(e.error).message) throw new Error(str(record(e.error).message));
        const data = Array.isArray(record(e.data).choices) ? record(e.data) : e;
        const choice = record(Array.isArray(data.choices) ? data.choices[0] : undefined);
        const msg = record(choice.delta || choice.message);
        const next = partsText(msg.content);
        if (next) { text += next; input.onText?.(text); }
        for (const raw of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
            const value = record(raw);
            const index = Number(value.index ?? calls.size);
            const fn = record(value.function);
            const old = calls.get(index) || { id: "", name: "", argumentsJson: "" };
            calls.set(index, { id: str(value.id) || old.id, name: old.name + str(fn.name), argumentsJson: old.argumentsJson + str(fn.arguments) });
        }
    });
    return { text, toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c).filter((c) => c.name && c.id) };
}
function jsonObject(raw: string): Record<string, unknown> { try { return record(JSON.parse(raw)); } catch { return {}; } }
function jsonResult(raw: string): unknown { try { return JSON.parse(raw); } catch { return raw; } }
function geminiParts(item: TextConversationItem): Record<string, unknown>[] {
    if (item.role === "tool") return [{ functionResponse: { id: item.callId, name: item.name, response: { result: jsonResult(item.content) } } }];
    if ("toolCalls" in item) return item.geminiParts?.length ? item.geminiParts : [
        ...(item.content ? [{ text: item.content }] : []),
        ...item.toolCalls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: jsonObject(c.argumentsJson) }, ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}) })),
    ];
    if (typeof item.content === "string") return [{ text: item.content }];
    return item.content.map((p) => {
        if (p.type === "text") return { text: p.text };
        const match = /^data:([^;,]+);base64,(.+)$/.exec(p.image_url.url);
        return match ? { inlineData: { mimeType: match[1], data: match[2] } } : { fileData: { fileUri: p.image_url.url, mimeType: "image/png" } };
    });
}
async function geminiTurn(input: TextTurnInput): Promise<TextTurnResult> {
    const base = input.config.baseUrl.replace(/\/+$/, "");
    const versioned = /\/v1(beta)?$/i.test(base) ? base : `${base}/v1beta`;
    const url = proxyApiUrl(`${versioned}/models/${encodeURIComponent(input.config.model.replace(/^models\//, ""))}:streamGenerateContent?alt=sse`);
    const messages = history(input);
    const systemText = messages.filter((m) => m.role === "system").map((m) => "content" in m ? partsText(m.content) : "").filter(Boolean).join("\n\n");
    const tools = input.tools || [];
    const response = await send(input, url, {
        contents: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: geminiParts(m) })),
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }], toolConfig: { functionCallingConfig: { mode: input.toolChoice === "required" ? "ANY" : input.toolChoice === "none" ? "NONE" : "AUTO" } } } : {}),
    }, true);
    let text = "", nextId = 0;
    const parts: Record<string, unknown>[] = [], calls: TextToolCall[] = [];
    await parseStream(response, input.signal, (e) => {
        if (record(e.error).message) throw new Error(str(record(e.error).message));
        const candidate = record(Array.isArray(e.candidates) ? e.candidates[0] : undefined);
        const data = record(candidate.content);
        for (const raw of Array.isArray(data.parts) ? data.parts : []) {
            const part = record(raw);
            parts.push(part);
            if (typeof part.text === "string") { text += part.text; input.onText?.(text); }
            const call = record(part.functionCall);
            if (str(call.name)) calls.push({ id: str(call.id) || `gemini-${++nextId}`, name: str(call.name), argumentsJson: JSON.stringify(record(call.args)), ...(part.thoughtSignature || part.thought_signature ? { thoughtSignature: str(part.thoughtSignature || part.thought_signature) } : {}) });
        }
    });
    return { text, toolCalls: calls, ...(parts.length ? { geminiParts: parts } : {}) };
}
/** Does not dispatch arbitrary tools; call through runTextAgent for a bounded loop. */
export async function requestTextTurn(input: TextTurnInput): Promise<TextTurnResult> {
    throwAborted(input.signal);
    if (input.config.apiFormat === "gemini") return geminiTurn(input);
    const key = `${input.config.apiFormat}|${input.config.baseUrl.trim().toLowerCase().replace(/\/+$/, "")}`;
    if (unsupportedResponses.has(key)) return chatTurn(input);
    try { return await responsesTurn(input); }
    catch (error) {
        if (!(error instanceof TextHttpError) || ![404, 405, 501].includes(error.status) || input.signal?.aborted) throw error;
        unsupportedResponses.add(key);
        return chatTurn(input);
    }
}
