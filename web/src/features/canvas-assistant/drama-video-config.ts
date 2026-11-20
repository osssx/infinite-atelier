import { nanoid } from "nanoid";
import { canvasCasUrl } from "@/features/backend-sync/canvas-cas";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { buildDramaVideoInput } from "./drama-pipeline-media";

export function findDramaVideoConfigs(sourceId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const targets = new Set(connections.filter(edge => edge.fromNodeId === sourceId).map(edge => edge.toNodeId));
    const configs = new Map<string, CanvasNodeData>();
    for (const node of nodes) {
        const shotId = node.metadata?.dramaShotId;
        if (node.type === CanvasNodeType.Config && shotId && targets.has(node.id) && !configs.has(shotId)) {
            configs.set(shotId, node);
        }
    }
    return configs;
}

export function buildDramaVideoConfigGraph(
    source: CanvasNodeData,
    inputs: ReturnType<typeof buildDramaVideoInput>[],
    nodes: CanvasNodeData[],
    connections: CanvasConnection[],
    style?: string,
    ratio?: string,
) {
    const configs = findDramaVideoConfigs(source.id, nodes, connections);
    const imageByKey = new Map(nodes.flatMap(node => {
        const key = node.metadata?.storageKey;
        return node.type === CanvasNodeType.Image && key && !node.metadata?.images?.length ? [[key, node] as const] : [];
    }));
    const added: CanvasNodeData[] = [];
    const edges: CanvasConnection[] = [];
    const configIds: string[] = [];
    const top = Math.max(source.position.y, ...Array.from(configs.values(), node => node.position.y + node.height + 32));
    let y = top;
    let imageByKeyAdded = 0;
    for (const { shot, prompt, referenceImages } of inputs) {
        if (configs.has(shot.id)) continue;
        const refs = referenceImages.flatMap(reference => {
            const key = reference.storageKey;
            if (!key || !/^cas:[a-f0-9]{64}$/.test(key)) return [];
            const existing = imageByKey.get(key);
            if (existing) return [{ node: existing, name: reference.name }];
            const image = createCanvasNode(CanvasNodeType.Image,
                { x: source.position.x + source.width + 160, y: top + 120 + imageByKeyAdded * 240 },
                { content: canvasCasUrl(key) ?? "", storageKey: key, status: "success", mimeType: reference.type });
            imageByKeyAdded++;
            image.title = `参考图 · ${reference.name}`;
            imageByKey.set(key, image);
            added.push(image);
            return [{ node: image, name: reference.name }];
        });
        const text = [
            prompt,
            style && `影片风格：${style}`,
            ...refs.map(ref => `${ref.name}：@[node:${ref.node.id}]`),
        ].filter(Boolean).join("\n");
        const config = createCanvasNode(CanvasNodeType.Config, { x: 0, y: 0 }, {
            generationMode: "video",
            videoMode: refs.length ? "omni_reference" : "text_to_video",
            dramaShotId: shot.id,
            prompt: text,
            composerContent: text,
            ...(ratio ? { videoRatio: ratio } : {}),
        });
        config.position = { x: source.position.x + source.width + 400, y };
        y += config.height + 32;
        config.title = `${shot.episodeId} · 镜头 ${shot.order} · 视频配置`;
        added.push(config);
        configs.set(shot.id, config);
        configIds.push(config.id);
        for (const fromNodeId of [source.id, ...refs.map(ref => ref.node.id)]) {
            edges.push({ id: nanoid(), fromNodeId, toNodeId: config.id });
        }
    }
    return { nodes: [...nodes, ...added], connections: [...connections, ...edges], configIds };
}
