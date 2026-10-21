/** Only safe navigation schemes, local absolute links, and same-document anchors. */
export function safeCanvasMarkdownHref(href: string | undefined): string | undefined {
    const value = href?.trim();
    if (!value) return undefined;
    return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(value) ? value : undefined;
}

/** Avoid data: and arbitrary schemes in images (large inline data can pin canvas memory). */
export function safeCanvasMarkdownImageSrc(src: string | undefined): string | undefined {
    const value = src?.trim();
    if (!value) return undefined;
    return /^(https?:\/\/|\/(?!\/))/i.test(value) ? value : undefined;
}

/**
 * Cheap compact-LOD preview: do not mount a Markdown parser at tiny zoom levels.
 * Retain prose while hiding common formatting syntax and verbose link URLs.
 */
export function compactCanvasMarkdown(content: string, limit = 900): string {
    return content.slice(0, limit)
        .replace(/^\s*```[^\n]*$/gm, "")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s{0,3}>\s?/gm, "")
        .replace(/^\s{0,3}(?:[-*+]\s+|\d+\.\s+)/gm, "• ")
        .replace(/!?\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
        .replace(/(\*\*|__)(.*?)\1/g, "$2")
        .replace(/(\*|_)(.*?)\1/g, "$2")
        .replace(/`([^`]+)`/g, "$1");
}
