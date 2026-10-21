import { memo } from "react";
import { Streamdown, type Components } from "streamdown";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { safeCanvasMarkdownHref, safeCanvasMarkdownImageSrc } from "@/lib/canvas/canvas-markdown-utils";
import "./canvas-text-markdown.css";

// Keep links independent from node drag/select and do not expose document.opener.
// React elements escape user text; HTML in the Markdown source is never interpreted.
const markdownComponents: Components = {
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
            style={{
                "--canvas-md-border": theme.node.stroke,
                "--canvas-md-muted": theme.node.muted,
                "--canvas-md-surface": theme.node.panel,
            } as React.CSSProperties}
        >
            <Streamdown
                mode="static"
                controls={false}
                skipHtml
                parseIncompleteMarkdown={false}
                components={markdownComponents}
            >
                {content}
            </Streamdown>
        </div>
    );
});
