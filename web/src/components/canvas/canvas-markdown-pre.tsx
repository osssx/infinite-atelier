import { cloneElement, isValidElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { WrapText } from "lucide-react";

/** Preserve Streamdown's built-in fenced code renderer (highlighting/copy) while
 * adding a local layout toggle. The default <pre> handler marks its <code> child
 * with data-block; retain that marker to distinguish fenced code from inline code. */
export function CanvasMarkdownPre(props: unknown) {
    // Streamdown accepts intrinsic pre attributes and arbitrary plugin props.
    const { children } = props as { children?: ReactNode };
    const [wrap, setWrap] = useState(true);
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
