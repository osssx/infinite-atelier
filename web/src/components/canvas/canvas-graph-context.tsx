import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { CanvasGraphIndex } from "@/lib/canvas/canvas-graph-index";
import { buildNodeMentionReferencesFromIndex, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { buildNodeGenerationInputsFromIndex, type NodeGenerationInput } from "./canvas-node-generation";

// Shared empties so consumers of an empty result keep a stable reference across graph changes.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const EMPTY_INPUTS: NodeGenerationInput[] = [];

const CanvasGraphIndexContext = createContext<CanvasGraphIndex | null>(null);

export function CanvasGraphIndexProvider({ index, children }: { index: CanvasGraphIndex; children: ReactNode }) {
    return <CanvasGraphIndexContext.Provider value={index}>{children}</CanvasGraphIndexContext.Provider>;
}

export function useCanvasGraphIndex() {
    const index = useContext(CanvasGraphIndexContext);
    if (!index) throw new Error("useCanvasGraphIndex must be used within CanvasGraphIndexProvider");
    return index;
}

/**
 * Resource references for a single node, computed on demand.
 *
 * Every caller subscribes to the graph index, so only mount one where the references are actually
 * shown (an open panel, or a text node being edited). Calling this per node would rebuild the
 * full-canvas work this replaced.
 */
export function useNodeMentionReferences(nodeId: string, enabled = true) {
    const index = useCanvasGraphIndex();
    return useMemo(() => (enabled ? buildNodeMentionReferencesFromIndex(index, nodeId) : EMPTY_REFERENCES), [enabled, index, nodeId]);
}

/** Generation inputs for a single node, computed on demand. Same mounting rule as above. */
export function useNodeGenerationInputs(nodeId: string) {
    const index = useCanvasGraphIndex();
    return useMemo(() => {
        const inputs = buildNodeGenerationInputsFromIndex(index, nodeId);
        return inputs.length ? inputs : EMPTY_INPUTS;
    }, [index, nodeId]);
}
