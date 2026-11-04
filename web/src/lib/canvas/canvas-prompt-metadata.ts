import type { CanvasNodeMetadata } from "@/types/canvas";

export function updateCanvasNodePrompt(metadata: CanvasNodeMetadata | undefined, prompt: string): CanvasNodeMetadata {
    return { ...metadata, prompt, ...(metadata?.composerContent !== undefined ? { composerContent: prompt } : {}) };
}
