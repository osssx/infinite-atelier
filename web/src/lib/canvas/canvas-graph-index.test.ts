import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { buildCanvasFixture } from "./canvas-fixtures";
import { buildCanvasGraphIndex } from "./canvas-graph-index";

// `@/i18n` reads localStorage while initialising, and the default node test environment has none.
// The stub has to be installed before anything pulls i18n in, hence the dynamic imports below.
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
};

const { buildNodeMentionReferencesFromIndex, getGenerationResourceNodesFromIndex, getMentionResourceNodesFromIndex, isResourceNode } = await import("./canvas-resource-references");
const { imageReferenceLabel } = await import("@/lib/image-reference-prompt");

// The linear-scan traversal these replaced, kept verbatim as an oracle. Only the data structure
// changed, so any difference in result is a regression.
function legacyContextResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return connections
        .filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && isResourceNode(node)));
}

function legacyConnectedConfigResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configConnection = connections.find((connection) => connection.fromNodeId === nodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return legacyContextResourceNodes(configConnection.toNodeId, nodes, connections).filter((node) => node.id !== nodeId);
}

function legacyMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = legacyConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = legacyContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    const node = nodes.find((item) => item.id === nodeId);
    return node && isResourceNode(node) ? [node] : [];
}

function legacyGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = legacyConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = legacyContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    return [];
}

const ids = (nodes: CanvasNodeData[]) => nodes.map((node) => node.id);

describe("canvas graph index", () => {
    it("matches the linear-scan traversal for mentions and generation inputs across random graphs", () => {
        for (const seed of [1, 7, 42, 1337]) {
            const { nodes, connections } = buildCanvasFixture({ nodeCount: 60, seed });
            const index = buildCanvasGraphIndex(nodes, connections);

            for (const node of nodes) {
                expect(ids(getMentionResourceNodesFromIndex(index, node.id)), `mention ${node.id} (seed ${seed})`).toEqual(ids(legacyMentionResourceNodes(node.id, nodes, connections)));
                expect(ids(getGenerationResourceNodesFromIndex(index, node.id)), `generation ${node.id} (seed ${seed})`).toEqual(ids(legacyGenerationResourceNodes(node.id, nodes, connections)));
            }
        }
    });

    it("fixture actually exercises the Config tier and the self fallback", () => {
        let configTier = 0;
        let selfFallback = 0;
        for (const seed of [1, 7, 42, 1337]) {
            const { nodes, connections } = buildCanvasFixture({ nodeCount: 60, seed });
            for (const node of nodes) {
                if (legacyConnectedConfigResourceNodes(node.id, nodes, connections).length) configTier += 1;
                else if (!legacyContextResourceNodes(node.id, nodes, connections).length && isResourceNode(node)) selfFallback += 1;
            }
        }

        // Without these shapes the randomized comparison above would pass vacuously.
        expect(configTier).toBeGreaterThan(0);
        expect(selfFallback).toBeGreaterThan(0);
    });

    it("preserves connection order, which is what numbers the reference labels", () => {
        const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: id } });
        const nodes: CanvasNodeData[] = [image("a"), image("b"), image("c"), { id: "target", type: CanvasNodeType.Text, title: "t", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: "t" } }];
        // Deliberately not in node-array order: labels must follow the connections array.
        const connections: CanvasConnection[] = [
            { id: "e1", fromNodeId: "c", toNodeId: "target" },
            { id: "e2", fromNodeId: "a", toNodeId: "target" },
            { id: "e3", fromNodeId: "b", toNodeId: "target" },
        ];
        const references = buildNodeMentionReferencesFromIndex(buildCanvasGraphIndex(nodes, connections), "target");

        expect(references.map((reference) => reference.nodeId)).toEqual(["c", "a", "b"]);
        // Per-kind numbering follows that same order.
        expect(references.map((reference) => reference.label)).toEqual([imageReferenceLabel(0), imageReferenceLabel(1), imageReferenceLabel(2)]);
    });

    it("keeps the Config fallback tiers, including the first matching outbound edge", () => {
        const config = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Config, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} });
        const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: id } });
        const text = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { prompt: id } });

        // `source` has both its own upstream resource and outbound edges to two Config nodes. Config
        // inputs must win outright rather than merging, and the first edge in array order decides.
        const nodes = [text("source"), image("own"), config("cfg-1"), config("cfg-2"), image("cfg-1-input"), image("cfg-2-input")];
        const connections: CanvasConnection[] = [
            { id: "e1", fromNodeId: "own", toNodeId: "source" },
            { id: "e2", fromNodeId: "source", toNodeId: "cfg-1" },
            { id: "e3", fromNodeId: "source", toNodeId: "cfg-2" },
            { id: "e4", fromNodeId: "cfg-1-input", toNodeId: "cfg-1" },
            { id: "e5", fromNodeId: "cfg-2-input", toNodeId: "cfg-2" },
        ];
        const index = buildCanvasGraphIndex(nodes, connections);

        expect(ids(getMentionResourceNodesFromIndex(index, "source"))).toEqual(["cfg-1-input"]);
        expect(ids(getGenerationResourceNodesFromIndex(index, "source"))).toEqual(["cfg-1-input"]);
    });

    it("keeps mention's self fallback without giving generation one", () => {
        const nodes: CanvasNodeData[] = [{ id: "lonely", type: CanvasNodeType.Image, title: "lonely", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "lonely" } }];
        const index = buildCanvasGraphIndex(nodes, []);

        expect(ids(getMentionResourceNodesFromIndex(index, "lonely"))).toEqual(["lonely"]);
        expect(ids(getGenerationResourceNodesFromIndex(index, "lonely"))).toEqual([]);
    });

    it("does not treat a node type without a registered definition as a resource", () => {
        const nodes: CanvasNodeData[] = [{ id: "plugin", type: "plugin:fixture", title: "plugin", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "plugin" } }];
        const index = buildCanvasGraphIndex(nodes, []);

        expect(ids(getMentionResourceNodesFromIndex(index, "plugin"))).toEqual([]);
    });

    it("indexes group children and neighbours once per graph revision", () => {
        const nodes: CanvasNodeData[] = [
            { id: "group", type: CanvasNodeType.Group, title: "g", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} },
            { id: "child-a", type: CanvasNodeType.Image, title: "a", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { groupId: "group", content: "a" } },
            { id: "child-b", type: CanvasNodeType.Image, title: "b", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { groupId: "group", content: "b" } },
        ];
        const index = buildCanvasGraphIndex(nodes, [{ id: "e1", fromNodeId: "child-a", toNodeId: "child-b" }]);

        expect(index.groupChildrenByGroupId.get("group")?.map((node) => node.id)).toEqual(["child-a", "child-b"]);
        expect(index.groupChildCountById.get("group")).toBe(2);
        expect([...(index.neighborsById.get("child-a") ?? [])]).toEqual(["child-b"]);
        expect([...(index.neighborsById.get("child-b") ?? [])]).toEqual(["child-a"]);
    });
});
