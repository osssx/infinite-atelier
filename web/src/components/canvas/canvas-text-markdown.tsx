import { memo } from "react";
import { Streamdown, type Components } from "streamdown";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { safeCanvasMarkdownHref, safeCanvasMarkdownImageSrc } from "@/lib/canvas/canvas-markdown-utils";
import { cachedCanvasMarkdownBlocks } from "@/lib/canvas/canvas-markdown-block-cache";
import { isSimpleCanvasText } from "@/lib/canvas/canvas-markdown-plain";
import { CanvasMarkdownPre } from "./canvas-markdown-pre";
import "./canvas-text-markdown.css";

// Keep links independent from node drag/select and do not expose document.opener.
// React elements escape user text; HTML in the Markdown source is never interpreted.
const markdownComponents: Components = {
    pre: CanvasMarkdownPre,
    a: ({ href, children, node: _node, ...rest }) => {
        const safe = safeCanvasMarkdownHref(href);
        if (!safe) return <span>{children}</span>;
        return (
            <a
                {...rest}
                href={safe}
                target="_blank"
                rel="noopener noreferrer"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
            >
                {children}
            </a>
        );
    },
    img: ({ src, alt, node: _node, ...rest }) => {
        const safe = safeCanvasMarkdownImageSrc(src);
        if (!safe) return <span>{alt ?? ""}</span>;
        return <img {...rest} src={safe} alt={alt ?? ""} loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" />;
    },
};

export const CanvasTextMarkdown = memo(function CanvasTextMarkdown({
    content, theme,
}: {
    content: string;
    theme: CanvasTheme;
}) {
    return (
        <div
            data-canvas-markdown
            className="canvas-node-markdown min-w-0 w-full"
            // Keep the code copy button clickable without starting a node drag.
            onPointerDown={(event) => {
                if ((event.target as Element).closest("button")) event.stopPropagation();
            }}
            onMouseDown={(event) => {
                if ((event.target as Element).closest("button")) event.stopPropagation();
            }}
            onDoubleClick={(event) => {
                if ((event.target as Element).closest("button")) event.stopPropagation();
            }}
            style={{
                "--canvas-md-border": theme.node.stroke,
                "--canvas-md-muted": theme.node.muted,
                "--canvas-md-surface": theme.node.panel,
                "--canvas-md-code-surface": theme.node.code.surface,
                "--canvas-md-code-header": theme.node.code.header,
                "--canvas-md-code-border": theme.node.code.stroke,
                "--canvas-md-code-text": theme.node.code.text,
                "--canvas-md-code-muted": theme.node.code.muted,
                "--canvas-md-code-control": theme.node.code.control,
                "--canvas-md-code-control-hover": theme.node.code.controlHover,
                "--canvas-md-code-scrollbar": theme.node.code.scrollbar,
            } as React.CSSProperties}
        >
            {isSimpleCanvasText(content) ? (
                <p data-canvas-plain-markdown>{content}</p>
            ) : (
                <Streamdown
                    mode="static"
                    controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
                    skipHtml
                    parseIncompleteMarkdown={false}
                    parseMarkdownIntoBlocksFn={cachedCanvasMarkdownBlocks}
                    components={markdownComponents}
                >
                    {content}
                </Streamdown>
            )}
        </div>
    );
});
