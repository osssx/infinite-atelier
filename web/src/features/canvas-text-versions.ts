import {readAssetDraft, readEpisodeDraft, readStoryboardDraft} from "../../server/canvas-text-content.mjs";
import type {CanvasNodeData} from "@/types/canvas";

export const TEXT_VERSIONS_LIMIT = 50;
export type TextVersion = NonNullable<NonNullable<CanvasNodeData["metadata"]>["textVersions"]>[number];
export type TextVersionSummary = Omit<TextVersion, "content" | "note"> & {
    note?: string | null;
    preview?: string;
    digest?: string;
    content?: string;
};

export const isDramaVersionNode = (node: CanvasNodeData) =>
    node.type === "drama:source" || node.type === "drama:episodes" || node.type === "drama:storyboard" || node.type === "drama:assets";

export const supportsTextVersions = (node: CanvasNodeData) => node.type === "text" || isDramaVersionNode(node);

export function versionNodeContent(node: CanvasNodeData) {
    const metadata = node.metadata;
    if (node.type === "drama:source") return metadata?.dramaDraft ?? metadata?.content ?? metadata?.dramaConfirmed ?? "";
    return isDramaVersionNode(node) ?
        metadata?.dramaDraft || metadata?.dramaConfirmed || metadata?.content || "" : metadata?.content ?? "";
}

export function canRestoreNodeVersion(node: CanvasNodeData, content: string) {
    if (node.type === "drama:assets") return Boolean(readAssetDraft(content));
    if (node.type === "drama:episodes") return Boolean(readEpisodeDraft(content)?.episodes.length);
    if (node.type === "drama:storyboard") return Boolean(readStoryboardDraft(content)?.shots.length);
    return Boolean(content.trim());
}
