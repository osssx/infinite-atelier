import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

/**
 * Deterministic PRNG (mulberry32). Fixtures must never use Math.random — a failing case has to be
 * reproducible from its seed alone.
 */
export function createSeededRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export type CanvasFixture = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

export type CanvasFixtureOptions = {
    nodeCount: number;
    seed?: number;
    /** Connections per node on average. */
    connectionRatio?: number;
    /** How many of the leading nodes are Groups. */
    groupCount?: number;
    /** Optional dense scene for perf-only LOD recovery smoke tests. */
    layout?: "spread" | "clustered";
    /**
     * What `metadata.content` the media nodes get.
     *
     * - `"remote"` (default) keeps the original behaviour: a URL on a host that does not exist. That
     *   is fine for graph/DOM assertions but fires one failed request per mounted media node, so it
     *   must not be used for a performance run.
     * - `"static"` points image nodes at `staticMediaUrl`; video and audio get no content, so nothing
     *   tries to decode a still image as video. Hydration leaves these untouched (neither
     *   `data:image/` nor backed by a storage key), so loading stays free of network and blob writes.
     * - `"none"` gives no media node any content — the most neutral option for graph and DOM cost.
     */
    mediaMode?: "remote" | "static" | "decoded" | "none";
    /** Required when `mediaMode` is `"static"`. Must be a same-origin asset URL, never a data URL. */
    staticMediaUrl?: string;
    /** Real encoded media assets for repeatable image/video/audio decode tests (perf fixture only). */
    staticVideoUrl?: string;
    staticAudioUrl?: string;
    /** Exact, representative 300-node workload used by the repeatable performance acceptance run. */
    profile?: "performance-300";
    /** Same-origin static poster image for video cards (the video itself is never played). */
    staticVideoPosterUrl?: string;
};

// A type with no registered definition, standing in for a plugin node: it must survive every path
// without being mistaken for a resource.
const PLUGIN_NODE_TYPE = "plugin:fixture";

/**
 * A reproducible canvas graph covering the shapes the culling and reference logic have to survive:
 * groups, negative coordinates, very large and very small nodes, cross-viewport edges, backwards
 * edges, media nodes, and nodes mid-generation.
 */
export function buildCanvasFixture(options: CanvasFixtureOptions): CanvasFixture {
    const { nodeCount, seed = 1, connectionRatio = 1.5, groupCount = 3, layout = "spread", mediaMode = "remote", staticMediaUrl, staticVideoUrl, staticAudioUrl, profile, staticVideoPosterUrl } = options;
    if (mediaMode === "static" && !staticMediaUrl) throw new Error('buildCanvasFixture: mediaMode "static" requires staticMediaUrl');
    if (mediaMode === "decoded" && (!staticMediaUrl || !staticVideoUrl || !staticAudioUrl)) throw new Error('buildCanvasFixture: decoded media mode requires all three same-origin asset URLs');
    const random = createSeededRandom(seed);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const groups = Math.max(0, Math.min(profile === "performance-300" ? 10 : groupCount, nodeCount));
    const profileTypes = profile === "performance-300" ? [
        ...Array<CanvasNodeType>(150).fill(CanvasNodeType.Image),
        ...Array<CanvasNodeType>(60).fill(CanvasNodeType.Video),
        ...Array<CanvasNodeType>(60).fill(CanvasNodeType.Text),
        ...Array<CanvasNodeType>(10).fill(CanvasNodeType.Audio),
        ...Array<CanvasNodeType>(10).fill(CanvasNodeType.Config),
    ] : null;
    // Deterministically interleave node types across the canvas so a dense viewport exercises
    // mixed media and editors instead of one large homogeneous band.
    if (profileTypes) for (let index = profileTypes.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [profileTypes[index], profileTypes[swapIndex]] = [profileTypes[swapIndex], profileTypes[index]];
    }
    let textNodeOrdinal = 0;

    const nodes: CanvasNodeData[] = [];
    for (let index = 0; index < nodeCount; index += 1) {
        const id = `node-${index}`;
        const metadata: CanvasNodeMetadata = {};
        if (profile === "performance-300" && index >= groups + 100 && index < groups + 120) metadata.perfSimulatedProgress = true;

        // Groups lead the array, mirroring how they are created before their children.
        if (index < groups) {
            nodes.push({ id, type: CanvasNodeType.Group, title: `Group ${index}`, position: { x: (index % 3) * 1400 - 700, y: Math.floor(index / 3) * 1400 - 700 }, width: 900 + index * 40, height: 700 + index * 30, metadata });
            continue;
        }

        // Keep the normal seeded mix for general graph tests. The acceptance profile uses
        // deterministic exact counts: 150 image, 60 video, 60 text, 10 audio, 10 config,
        // and 10 groups. Since groups occupy the first slots, this table maps the remaining
        // 290 indices directly without consuming PRNG state.
        const profileType = profileTypes?.[index - groups] ?? null;
        const type = profileType ?? pick([CanvasNodeType.Image, CanvasNodeType.Image, CanvasNodeType.Text, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Config, PLUGIN_NODE_TYPE]);
        const isMedia = type === CanvasNodeType.Image || type === CanvasNodeType.Video || type === CanvasNodeType.Audio;
        if (isMedia && mediaMode === "remote") metadata.content = `https://example.test/${id}`;
        // Video and audio deliberately stay empty under "static": feeding a still image to <video>
        // only produces decode errors, and it would not measure anything the image nodes do not.
        if (type === CanvasNodeType.Image && (mediaMode === "static" || mediaMode === "decoded")) metadata.content = staticMediaUrl;
        if (type === CanvasNodeType.Video && profile === "performance-300" && mediaMode === "static") {
            // VideoNodeContent uses preload="none" and assigns src only after a user click.
            // The sample video URL is present to render its cover affordance, with no playback.
            metadata.perfStaticPosterUrl = staticVideoPosterUrl;
            metadata.content = staticVideoUrl;
        }
        if (type === CanvasNodeType.Video && mediaMode === "decoded") metadata.content = staticVideoUrl;
        if (type === CanvasNodeType.Audio && mediaMode === "decoded") metadata.content = staticAudioUrl;
        if (type === CanvasNodeType.Text) {
            const ordinal = textNodeOrdinal++;
            metadata.content = profile !== "performance-300" ? `text ${index}`
                : ordinal < 20 ? `Short note ${ordinal}: a compact text card.`
                    : ordinal < 40 ? `# Long note ${ordinal}\n\n${"This long markdown fixture contains headings, **emphasis**, lists, links, and realistic paragraphs to exercise editor and preview rendering. ".repeat(16)}`
                        : `# Complex note ${ordinal}\n\n| Stage | Detail |\n| --- | --- |\n| Input | Markdown table |\n\n\`\`\`ts\nexport const sample = { enabled: true, count: 3 };\n\`\`\`\n\n- first item\n- second item\n\n> A quoted paragraph used to verify compact summaries.`;
        }
        if (type === CanvasNodeType.Config) metadata.prompt = `config ${index}`;
        if (profile !== "performance-300" && random() < 0.15) metadata.status = "loading";

        // Spread nodes wide enough that plenty of edges cross the viewport, and let some sit far
        // off in negative space. A few get extreme dimensions so group/bounds math is exercised.
        const extreme = random() < 0.08;
        const width = extreme ? 4000 + Math.floor(random() * 4000) : 160 + Math.floor(random() * 520);
        const height = extreme ? 3000 + Math.floor(random() * 3000) : 120 + Math.floor(random() * 480);
        const position = { x: Math.floor((random() - 0.5) * 12000), y: Math.floor((random() - 0.5) * 12000) };
        if (groups > 0 && random() < 0.4) metadata.groupId = `node-${Math.floor(random() * groups)}`;

        nodes.push({ id, type, title: `${type} ${index}`, position, width, height, metadata });
    }

    if (layout === "clustered") {
        // Preserve the graph, types, metadata and edge count. Only layout density
        // changes so a perf browser can observe 24+ full nodes restoring in one view.
        nodes.forEach((node, index) => {
            node.position = { x: (index % 10) * 142 - 640, y: Math.floor(index / 10) * 94 - 800 };
            node.width = Math.min(node.width, 220);
            node.height = Math.min(node.height, 180);
        });
    }

    const connections: CanvasConnection[] = [];
    const target = Math.round(nodeCount * connectionRatio);
    const connectable = nodes.filter((node) => node.type !== CanvasNodeType.Group);
    let attempts = 0;
    while (connections.length < target && connectable.length > 1 && attempts < target * 20) {
        attempts += 1;
        const from = pick(connectable);
        const to = pick(connectable);
        if (from.id === to.id) continue;
        // Deliberately unordered: a backwards edge (from a later node to an earlier one) is the case
        // that breaks endpoint-only culling.
        if (connections.some((connection) => connection.fromNodeId === from.id && connection.toNodeId === to.id)) continue;
        connections.push({ id: `conn-${connections.length}`, fromNodeId: from.id, toNodeId: to.id });
    }

    return { nodes, connections };
}
