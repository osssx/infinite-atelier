import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/**
 * Adjacency view of one canvas graph, built in a single O(N+E) pass.
 *
 * The incidence lists deliberately keep the order of the source `connections` array. Resource
 * reference labels ("参考图 1/2/3") are numbered in that order, and Config inputs take the first
 * matching outbound edge — rebuilding them from a differently-ordered structure would silently
 * reshuffle Seedance multi-reference inputs.
 */
export type CanvasGraphIndex = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    nodeById: Map<string, CanvasNodeData>;
    connectionsById: Map<string, CanvasConnection>;
    inboundByNodeId: Map<string, CanvasConnection[]>;
    outboundByNodeId: Map<string, CanvasConnection[]>;
    groupChildrenByGroupId: Map<string, CanvasNodeData[]>;
    groupChildCountById: Map<string, number>;
    neighborsById: Map<string, Set<string>>;
};

export function buildCanvasGraphIndex(nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasGraphIndex {
    const nodeById = new Map<string, CanvasNodeData>();
    const groupChildrenByGroupId = new Map<string, CanvasNodeData[]>();
    const groupChildCountById = new Map<string, number>();

    for (const node of nodes) {
        nodeById.set(node.id, node);
        const groupId = node.metadata?.groupId;
        if (!groupId) continue;
        const children = groupChildrenByGroupId.get(groupId);
        if (children) children.push(node);
        else groupChildrenByGroupId.set(groupId, [node]);
        groupChildCountById.set(groupId, (groupChildCountById.get(groupId) ?? 0) + 1);
    }

    const connectionsById = new Map<string, CanvasConnection>();
    const inboundByNodeId = new Map<string, CanvasConnection[]>();
    const outboundByNodeId = new Map<string, CanvasConnection[]>();
    const neighborsById = new Map<string, Set<string>>();

    // Single forward pass — never a per-node rescan of `connections`.
    for (const connection of connections) {
        connectionsById.set(connection.id, connection);
        appendConnection(outboundByNodeId, connection.fromNodeId, connection);
        appendConnection(inboundByNodeId, connection.toNodeId, connection);
        appendNeighbor(neighborsById, connection.fromNodeId, connection.toNodeId);
        appendNeighbor(neighborsById, connection.toNodeId, connection.fromNodeId);
    }

    return { nodes, connections, nodeById, connectionsById, inboundByNodeId, outboundByNodeId, groupChildrenByGroupId, groupChildCountById, neighborsById };
}

function appendConnection(map: Map<string, CanvasConnection[]>, key: string, connection: CanvasConnection) {
    const list = map.get(key);
    if (list) list.push(connection);
    else map.set(key, [connection]);
}

function appendNeighbor(map: Map<string, Set<string>>, key: string, neighborId: string) {
    const set = map.get(key);
    if (set) set.add(neighborId);
    else map.set(key, new Set([neighborId]));
}
