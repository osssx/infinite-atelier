import { CanvasNodeType } from "@/types/canvas";

/**
 * Keep paint/layout work for media and plain text isolated inside the already
 * clipped content viewport. Do not apply to batch galleries, custom plugin
 * nodes, or active text editors: they may legitimately overflow their shell.
 *
 * CSS content-visibility is a progressive enhancement: unsupported browsers
 * ignore it and retain the existing fully rendered content.
 */
export function shouldContainCanvasContent(type: string, isBatchRoot: boolean, isEditingContent: boolean): boolean {
    if (isBatchRoot || isEditingContent) return false;
    return type === CanvasNodeType.Image ||
        type === CanvasNodeType.Video ||
        type === CanvasNodeType.Audio ||
        type === CanvasNodeType.Text;
}

export const CANVAS_CONTENT_VISIBILITY_STYLE = {
    contentVisibility: "auto",
    containIntrinsicSize: "auto 160px 120px",
} as const;
