import { requestTextTurn, type TextConversationItem, type TextToolCall, type TextToolSpec, type TextTurnInput, type TextTurnResult } from "./text-model-adapter";

export type TextAgentEvent =
    | { type: "tool_start"; call: TextToolCall }
    | { type: "tool_complete"; call: TextToolCall; error?: string }
    | { type: "finished"; rounds: number; calls: number };
export type TextAgentInput = Omit<TextTurnInput, "onText"> & {
    executeTool: (call: TextToolCall, context: { signal?: AbortSignal }) => Promise<string>;
    onText?: (finalText: string) => void;
    onEvent?: (event: TextAgentEvent) => void;
    maxToolRounds?: number;
    maxToolCalls?: number;
    maxToolOutputChars?: number;
    /** Used by tests and alternate provider transports; defaults to requestTextTurn. */
    generateTurn?: (input: TextTurnInput) => Promise<TextTurnResult>;
};

function assertNotCanceled(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/** Isolated per-run history; never execute a function based on its model-supplied name alone. */
export async function runTextAgent(input: TextAgentInput): Promise<string> {
    const roundsLimit = Math.max(1, Math.min(20, Math.floor(input.maxToolRounds ?? 6)));
    const callsLimit = Math.max(1, Math.min(50, Math.floor(input.maxToolCalls ?? 12)));
    const outputLimit = Math.max(256, Math.min(131072, Math.floor(input.maxToolOutputChars ?? 32768)));
    const tools: TextToolSpec[] = input.tools || [];
    const permitted = new Set(tools.map((tool) => tool.name));
    const messages: TextConversationItem[] = [...input.messages];
    const generate = input.generateTurn || requestTextTurn;
    let rounds = 0;
    let calls = 0;
    for (;;) {
        assertNotCanceled(input.signal);
        const turn = await generate({ config: input.config, messages: [...messages], tools, toolChoice: input.toolChoice, signal: input.signal });
        assertNotCanceled(input.signal);
        if (!turn.toolCalls.length) {
            input.onText?.(turn.text);
            input.onEvent?.({ type: "finished", rounds, calls });
            return turn.text;
        }
        if (++rounds > roundsLimit) throw new Error(`Text agent exceeded ${roundsLimit} tool rounds`);
        if (calls + turn.toolCalls.length > callsLimit) throw new Error(`Text agent exceeded ${callsLimit} tool calls`);
        const seenIds = new Set<string>();
        for (const call of turn.toolCalls) {
            if (!permitted.has(call.name)) throw new Error(`Text agent requested an unauthorized tool: ${call.name}`);
            if (!call.id || seenIds.has(call.id)) throw new Error("Text agent returned an invalid or duplicate tool call ID");
            seenIds.add(call.id);
            let args: unknown;
            try { args = JSON.parse(call.argumentsJson); } catch { throw new Error(`Text agent returned invalid arguments for ${call.name}`); }
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`Text agent returned non-object arguments for ${call.name}`);
        }
        messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls, responseOutput: turn.responseOutput, geminiParts: turn.geminiParts });
        for (const call of turn.toolCalls) {
            assertNotCanceled(input.signal);
            calls++;
            input.onEvent?.({ type: "tool_start", call });
            let result = "";
            let failure: string | undefined;
            try {
                result = await input.executeTool(call, { signal: input.signal });
            } catch (error) {
                assertNotCanceled(input.signal);
                failure = error instanceof Error ? error.message : String(error);
                result = JSON.stringify({ error: failure });
            }
            assertNotCanceled(input.signal);
            if (typeof result !== "string") throw new Error(`Tool ${call.name} returned a non-string result`);
            if (result.length > outputLimit) result = result.slice(0, outputLimit) + "\n[tool result truncated]";
            input.onEvent?.({ type: "tool_complete", call, ...(failure ? { error: failure } : {}) });
            messages.push({ role: "tool", callId: call.id, name: call.name, content: result });
        }
    }
}
