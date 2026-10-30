/** Text model prompts may include multiple selected Skill documents.
 * Limits are in UTF-8 bytes; image/audio/video keep their existing prompt limits.
 * These caps match openai-model-adapter.mjs on the backend.
 */
export const MAX_TEXT_PROMPT_BYTES = 512 * 1024;
export const MAX_TEXT_HISTORY_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

export function assertTextPromptSize(value: string): void {
  if (encoder.encode(value).byteLength > MAX_TEXT_PROMPT_BYTES)
    throw Error("文本提示词与 Skill 上下文合计超过 512 KiB 限制");
}

export function assertTextHistorySize(messages: readonly {role: string; content: string}[]): void {
  let total = 0;
  for (const message of messages) {
    const bytes = encoder.encode(message.content).byteLength;
    if ((message.role === "assistant" || message.role === "tool" ?
      message.content.length > 32768 : bytes > MAX_TEXT_PROMPT_BYTES))
      throw Error("文本消息超过单条大小限制");
    total += bytes;
    if (total > MAX_TEXT_HISTORY_BYTES)
      throw Error("文本对话与 Skill 上下文合计超过 1 MiB 限制");
  }
}
