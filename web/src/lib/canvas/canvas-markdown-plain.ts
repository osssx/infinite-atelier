/** Conservative single-line Markdown fast path: only literal text with no formatting or autolinks. */
export function isSimpleCanvasText(content: string): boolean {
    if (!content || content.length > 4096 || /[\r\n\t]/.test(content)) return false;
    // Preserve Markdown syntax, HTML entities, escaping and GFM auto-linking.
    if (/[\\`*_~#<>\[\]|&@]/.test(content) || /(?:https?:\/\/|www\.|\b[a-z\d-]+\.[a-z]{2,}\b)/i.test(content)) return false;
    if (/^\s{4,}/.test(content) || /^\s*(?:\d+[.)]\s|[-+]\s|={2,}\s*$|-{3,}\s*$)/.test(content)) return false;
    return true;
}
