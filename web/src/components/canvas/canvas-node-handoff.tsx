import { memo, useCallback, useEffect, useState } from "react";

import type { CanvasNodeData } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";
import { getCompactImageSource } from "@/lib/canvas/canvas-lod-preview";
import { keepCompactDuringHandoff } from "@/lib/canvas/canvas-node-handoff";
import { CanvasNode } from "./canvas-node";
import { CompactCanvasNode } from "./canvas-node-compact";
import type { SharedNodeProps } from "./canvas-node-layer";

type Props = {
    data: CanvasNodeData;
    showFull: boolean;
    showImagePreview: boolean;
    preferImageThumbnail: boolean;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    showPanel: boolean;
    groupChildCount: number;
    isGroupDropTarget: boolean;
    batchExpanded: boolean;
    showImageInfo: boolean;
    shared: SharedNodeProps;
    onMediaPlaybackChange: (nodeId: string, playing: boolean) => void;
};

/**
 * Both representations share the same world-space geometry. The compact visual remains
 * painted while the heavy editor / image decoder warms up and is only relinquished after
 * the full node has signaled visual readiness and a paint has had a chance to occur.
 *
 * Forcing compact mode unmounts the expensive full DOM immediately (avoids zoom jank).
 * While transitioning in, exactly one sibling owns pointer interaction and data-node-id.
 * Unlike swapping keyed components, the compact image stays mounted throughout hydration.
 */
export const CanvasNodeHandoff = memo(function CanvasNodeHandoff({
    data, showFull, showImagePreview, preferImageThumbnail, isSelected, isRelated, isFocusRelated,
    isConnectionTarget, isConnecting, showPanel, groupChildCount, isGroupDropTarget,
    batchExpanded, showImageInfo, shared, onMediaPlaybackChange,
}: Props) {
    // Readiness belongs to a particular visual resource, not merely the node ID. A generated
    // image replacing another image must not inherit the previous one's fully-visible state.
    const mediaSource = data.type === CanvasNodeType.Image
        ? getCompactImageSource(data)
        : data.type === CanvasNodeType.Video || data.type === CanvasNodeType.Audio
          ? data.metadata?.content
          : undefined;
    // Use the source string directly: concatenating a base64 image data URL every zoom
    // render would copy megabytes of text per node and defeat our performance target.
    const visualKey = mediaSource || data.type;
    const [visualReadyKey, setVisualReadyKey] = useState<string | null>(null);
    const [shownKey, setShownKey] = useState<string | null>(null);
    const [settledKey, setSettledKey] = useState<string | null>(null);
    const onVisualReady = useCallback(() => setVisualReadyKey(visualKey), [visualKey]);

    useEffect(() => {
        if (!showFull) {
            setVisualReadyKey(null);
            setShownKey(null);
            setSettledKey(null);
        }
    }, [showFull]);

    useEffect(() => {
        if (!showFull || visualReadyKey !== visualKey || shownKey === visualKey) return;
        const frame = requestAnimationFrame(() => setShownKey(visualKey));
        return () => cancelAnimationFrame(frame);
    }, [showFull, visualReadyKey, visualKey, shownKey]);

    const interactiveFull = showFull && shownKey === visualKey;

    // Preserve the preview for the complete CSS opacity transition (160ms), then
    // release its image/DOM until the next source change or compact downgrade.
    useEffect(() => {
        if (!interactiveFull || settledKey === visualKey) return;
        const timer = setTimeout(() => setSettledKey(visualKey), 185);
        return () => clearTimeout(timer);
    }, [interactiveFull, settledKey, visualKey]);

    const keepCompact = keepCompactDuringHandoff(showFull, visualKey, shownKey, settledKey);

    return (
        <>
            {keepCompact ? (
                <CompactCanvasNode
                    data={data}
                    isSelected={isSelected}
                    isRelated={isRelated}
                    isGroupDropTarget={isGroupDropTarget}
                    groupChildCount={groupChildCount}
                    showImagePreview={showImagePreview}
                    hitActive={!interactiveFull}
                />
            ) : null}
            {showFull ? (
                <CanvasNode
                    {...shared}
                    data={data}
                    isSelected={isSelected}
                    isRelated={isRelated}
                    isFocusRelated={isFocusRelated}
                    isConnectionTarget={isConnectionTarget}
                    isConnecting={isConnecting}
                    showPanel={showPanel}
                    groupChildCount={groupChildCount}
                    isGroupDropTarget={isGroupDropTarget}
                    batchExpanded={batchExpanded}
                    showImageInfo={showImageInfo}
                    onMediaPlaybackChange={onMediaPlaybackChange}
                    onVisualReady={onVisualReady}
                    visualShown={interactiveFull}
                    preferImageThumbnail={preferImageThumbnail}
                    handoffActive
                />
            ) : null}
        </>
    );
});
