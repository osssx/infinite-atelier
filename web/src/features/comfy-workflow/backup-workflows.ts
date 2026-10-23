import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { canonicalComfyJson, comfySha256, createComfyTemplate, type ComfyWorkflowTemplate } from "./template-schema";
import { getComfyTemplate } from "./template-registry";

export type ComfyBackupRecord = {
    templateId: string;
    revision: string;
    path: string;
    sha256: string;
    requiredClassTypes: string[];
    requiredModelAssets: string[];
};
export function referencedComfyVersions(projects: readonly CanvasProject[]) {
    const result = new Map<string, {templateId:string;revision:string}>();
    for (const project of projects) for (const node of project.nodes) {
        if (node.type !== "comfy:workflow") continue;
        const meta = node.metadata?.comfyWorkflow;
        if (!meta?.templateId || !meta.templateRevision) throw new Error("Backup has unbound ComfyUI node: " + node.id);
        result.set(meta.templateId + "@" + meta.templateRevision, { templateId:meta.templateId, revision:meta.templateRevision });
    }
    return [...result.values()];
}
export async function exportComfyBackupTemplates(projects: readonly CanvasProject[]) {
    const records: ComfyBackupRecord[] = [];
    const files = new Map<string, Blob>();
    for (const ref of referencedComfyVersions(projects)) {
        const template = await getComfyTemplate(ref.templateId, ref.revision);
        if (!template) throw new Error("Missing ComfyUI template dependency: " + ref.templateId + "@" + ref.revision);
        const { id: _id, revision: _revision, ...payload } = template;
        const json = canonicalComfyJson(payload);
        const sha = await comfySha256(json);
        if (sha !== template.revision) throw new Error("ComfyUI template hash mismatch during export");
        const path = "workflows/" + sha + ".json";
        if (!files.has(path)) files.set(path, new Blob([json], { type:"application/json" }));
        records.push({ templateId:ref.templateId, revision:sha, path, sha256:sha,
            requiredClassTypes:[...template.requirements.classTypes],
            requiredModelAssets:[...(template.requirements.modelAssets || [])] });
    }
    return { records, files };
}
export async function verifyComfyBackupTemplates(records: readonly ComfyBackupRecord[], zip: ReadonlyMap<string, Blob>): Promise<ComfyWorkflowTemplate[]> {
    const parsed = new Map<string, unknown>();
    const templates: ComfyWorkflowTemplate[] = [];
    for (const entry of records) {
        let payload = parsed.get(entry.path);
        if (payload === undefined) {
            const blob = zip.get(entry.path);
            if (!blob || blob.size > 2_000_000) throw new Error("Missing or oversized Comfy template package");
            try { payload = JSON.parse(await blob.text()); }
            catch { throw new Error("Invalid Comfy template JSON in backup"); }
            const canonical = canonicalComfyJson(payload);
            if (await comfySha256(canonical) !== entry.sha256) throw new Error("Comfy template package SHA-256 mismatch");
            parsed.set(entry.path, payload);
        }
        const template = await createComfyTemplate(entry.templateId, payload);
        if (template.revision !== entry.revision || template.revision !== entry.sha256)
            throw new Error("Comfy template version mismatch: " + entry.templateId);
        if (canonicalComfyJson(entry.requiredClassTypes) !== canonicalComfyJson(template.requirements.classTypes) ||
            canonicalComfyJson(entry.requiredModelAssets) !== canonicalComfyJson(template.requirements.modelAssets || []))
            throw new Error("Comfy template capability metadata mismatch");
        templates.push(template);
    }
    return templates;
}

/** Never trust another machine's local ComfyUI instance IDs. Preserve ports for read-only inspection. */
export function unbindImportedComfyProjects(projects: readonly CanvasProject[], templates: readonly ComfyWorkflowTemplate[]): CanvasProject[] {
    const byKey = new Map(templates.map((t) => [t.id + "@" + t.revision, t]));
    return projects.map((project) => ({ ...project, nodes:project.nodes.map((node) => {
        if (node.type !== "comfy:workflow" || !node.metadata?.comfyWorkflow) return node;
        const binding = node.metadata.comfyWorkflow;
        const template = byKey.get(binding.templateId + "@" + binding.templateRevision);
        if (!template) throw new Error("Missing template while rebuilding imported port metadata");
        // Discard untrusted cached port metadata and rebuild it from the hashed template.
        const comfyPorts = template.ports.map(({id,label,direction,valueKind,required}) => ({id,label,direction,valueKind,required}));
        return { ...node, metadata: {
            ...node.metadata,
            comfyPorts,
            comfyWorkflow: { ...binding, instanceId:undefined, bindingState:"needs-instance-binding" as const },
        } };
    }) }));
}
