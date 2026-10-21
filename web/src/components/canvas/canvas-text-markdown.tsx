import { cloneElement, isValidElement, memo, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { WrapText } from "lucide-react";
import { Streamdown, type Components } from "streamdown";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { safeCanvasMarkdownHref, safeCanvasMarkdownImageSrc } from "@/lib/canvas/canvas-markdown-utils";
import { cachedCanvasMarkdownBlocks } from "@/lib/canvas/canvas-markdown-block-cache";
import { isSimpleCanvasText } from "@/lib/canvas/canvas-markdown-plain";
import "./canvas-text-markdown.css";

/** Preserve Streamdown's built-in fenced code renderer (highlighting/copy) while
 * adding a local layout toggle. The default <pre> handler marks its <code> child
 * with data-block; retain that marker to distinguish fenced code from inline code. */
function CanvasMarkdownPre(props: unknown) {
    // Streamdown accepts intrinsic pre attributes and arbitrary plugin props.
    const { children } = props as { children?: ReactNode };
    const [wrap, setWrap] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const [actionsContainer, setActionsContainer] = useState<HTMLElement | null>(null);

    // Streamdown owns the copy toolbar. Mount our toggle into the SAME flex
    // container so that both buttons always have the same vertical alignment.
    useLayoutEffect(() => {
        const actions = containerRef.current?.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]') ?? null;
        setActionsContainer(actions);
    }, [children]);

    const code = isValidElement(children)
        ? cloneElement(children as ReactElement<{ "data-block"?: string }>, { "data-block": "true" })
        : children;
    return (
        <div ref={containerRef} className="canvas-md-code-block" data-canvas-code-wrap={wrap ? "on" : "off"}>
            {code}
            {actionsContainer
                ? createPortal(
                    <button
                        type="button"
                        className="canvas-md-code-wrap-toggle"
                        aria-label={wrap ? "Disable code wrapping" : "Enable code wrapping"}
                        aria-pressed={wrap}
                        title={wrap ? "关闭自动换行" : "自动换行"}
                        onClick={(event) => {
                            event.stopPropagation();
                            setWrap((current) => !current);
                        }}
                    >
                        <WrapText size={14} aria-hidden="true" />
                    </button>,
                    actionsContainer,
                )
                : null}
        </div>
    );
}

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
