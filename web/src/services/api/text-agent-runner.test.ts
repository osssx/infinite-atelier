import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { requestTextTurn, type TextTurnResult } from "./text-model-adapter";
import { runTextAgent } from "./text-agent-runner";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/api-proxy", () => ({ proxyApiUrl: (url: string) => url }));

const skillTool = { name: "activate_skill", description: "Load a skill", parameters: { type: "object", properties: { skill_id: { type: "string" } }, required: ["skill_id"] } };
const configFor = (format: "openai" | "gemini", name: string): AiConfig => ({
    ...defaultConfig,
    apiFormat: format,
    baseUrl: format === "gemini" ? `https://${name}.example.com` : `https://${name}.example.com/v1`,
    model: format === "gemini" ? "gemini-test" : "test-model",
    apiKey: "test-key",
    systemPrompt: "Follow the user request",
    reasoningEffort: "auto",
});
function sse(...values: object[]) {
    const data = values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(data);
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            // Deliberately split inside JSON, SSE headers and unicode byte sequences.
            for (let i = 0; i < bytes.length; i += 11) controller.enqueue(bytes.slice(i, i + 11));
            controller.close();
        },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
function responseCompleted(output: unknown[]) { return { type: "response.completed", response: { output } }; }
const user = [{ role: "user" as const, content: "Please use a skill" }];
const readCalls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
afterEach(() => vi.unstubAllGlobals());

describe("P0 provider adapters and agent tool loops", () => {
    it("round trips OpenAI Responses tool calls, opaque output items and tool results", async () => {
        const reasoning = { type: "reasoning", id: "rs_1", summary: [] };
        const functionCall = { type: "function_call", id: "fc_1", call_id: "call_1", name: "activate_skill", arguments: "{\"skill_id\":\"storyboard\"}" };
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(sse(responseCompleted([reasoning, functionCall])))
            .mockResolvedValueOnce(sse({ type: "response.output_text.delta", delta: "Six " }, { type: "response.output_text.delta", delta: "shots" }, responseCompleted([{ type: "message", content: [{ type: "output_text", text: "Six shots" }] }])));
        vi.stubGlobal("fetch", fetchMock);
        const executed = vi.fn().mockResolvedValue("SKILL.md loaded");
        const updates: string[] = [];
        const answer = await runTextAgent({ config: configFor("openai", "responses"), messages: user, tools: [skillTool], executeTool: executed, onText: (text) => updates.push(text) });
        expect(answer).toBe("Six shots");
        expect(updates).toEqual(["Six shots"]); // Intermediate model turns are not final canvas text.
        expect(executed).toHaveBeenCalledOnce();
        const [first, second] = readCalls(fetchMock);
        expect(first).toMatchObject({ model: "test-model", tool_choice: "auto" });
        expect(second.input).toEqual(expect.arrayContaining([reasoning, functionCall, { type: "function_call_output", call_id: "call_1", output: "SKILL.md loaded" }]));
    });

    it("falls back on missing Responses endpoint and reconstructs fragmented Chat Completions tool calls", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('{"error":{"message":"missing"}}', { status: 404 }))
            .mockResolvedValueOnce(sse(
                { choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", type: "function", function: { name: "activate_", arguments: "{\"skill" } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "skill", arguments: "_id\":\"a\"}" } }] } }] },
            ))
            .mockResolvedValueOnce(sse({ choices: [{ delta: { content: "Done" } }] }));
        vi.stubGlobal("fetch", fetchMock);
        const executeTool = vi.fn().mockResolvedValue("Loaded");
        const answer = await runTextAgent({ config: configFor("openai", "fallback"), messages: user, tools: [skillTool], executeTool });
        expect(answer).toBe("Done");
        expect(executeTool).toHaveBeenCalledWith({ id: "c2", name: "activate_skill", argumentsJson: '{"skill_id":"a"}' }, expect.anything());
        const calls = readCalls(fetchMock);
        expect(calls[1].tools).toBeDefined();
        expect(calls[2].messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "activate_skill", arguments: '{"skill_id":"a"}' } }] }),
            { role: "tool", tool_call_id: "c2", content: "Loaded" },
        ]));
    });

    it("replays Gemini signed functionCall and functionResponse", async () => {
        const fn = { functionCall: { name: "activate_skill", id: "g1", args: { skill_id: "xyz" } }, thoughtSignature: "opaque-signature" };
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(sse({ candidates: [{ content: { parts: [fn] } }] }))
            .mockResolvedValueOnce(sse({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }));
        vi.stubGlobal("fetch", fetchMock);
        const answer = await runTextAgent({ config: configFor("gemini", "gemini"), messages: user, tools: [skillTool], executeTool: async () => "loaded" });
        expect(answer).toBe("OK");
        const [, second] = readCalls(fetchMock);
        expect(second.contents).toEqual(expect.arrayContaining([
            { role: "model", parts: [fn] },
            { role: "user", parts: [{ functionResponse: { id: "g1", name: "activate_skill", response: { result: "loaded" } } }] },
        ]));
        expect(second.tools).toBeDefined();
    });

    it("does not execute unknown tools or malformed arguments", async () => {
        const generateTurn = vi.fn().mockResolvedValue({ text: "", toolCalls: [{ id: "c", name: "delete_files", argumentsJson: "{}" }] });
        const executeTool = vi.fn();
        await expect(runTextAgent({ config: configFor("openai", "deny"), messages: user, tools: [skillTool], executeTool, generateTurn })).rejects.toThrow(/unauthorized tool/);
        expect(executeTool).not.toHaveBeenCalled();
        generateTurn.mockResolvedValue({ text: "", toolCalls: [{ id: "c", name: "activate_skill", argumentsJson: "{" }] });
        await expect(runTextAgent({ config: configFor("openai", "deny"), messages: user, tools: [skillTool], executeTool, generateTurn })).rejects.toThrow(/invalid arguments/);
    });

    it("limits call rounds and cancels before the next request", async () => {
        const alwaysCall: TextTurnResult = { text: "", toolCalls: [{ id: "c", name: "activate_skill", argumentsJson: "{}" }] };
        const generateTurn = vi.fn().mockResolvedValue(alwaysCall);
        await expect(runTextAgent({ config: configFor("openai", "limit"), messages: user, tools: [skillTool], generateTurn, executeTool: async () => "ok", maxToolRounds: 2 })).rejects.toThrow(/exceeded 2 tool rounds/);
        const controller = new AbortController();
        const stop = vi.fn(async () => { controller.abort(); return "ignored"; });
        generateTurn.mockClear();
        await expect(runTextAgent({ config: configFor("openai", "cancel"), messages: user, tools: [skillTool], generateTurn, executeTool: stop, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(generateTurn).toHaveBeenCalledTimes(1);
    });

    it("returns ordinary text without executing tools", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(sse(responseCompleted([{ type: "message", content: [{ type: "output_text", text: "Plain text" }] }])));
        vi.stubGlobal("fetch", fetchMock);
        const turn = await requestTextTurn({ config: configFor("openai", "plain"), messages: user });
        expect(turn.text).toBe("Plain text");
        expect(turn.toolCalls).toEqual([]);
        expect(readCalls(fetchMock)[0]).not.toHaveProperty("tools");
    });
});
