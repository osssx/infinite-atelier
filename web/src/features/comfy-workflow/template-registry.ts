import localforage from "localforage";
import { createComfyTemplate, verifyComfyTemplate, type ComfyObjectInfo, type ComfyTemplatePayload, type ComfyWorkflowTemplate } from "./template-schema";

const db = localforage.createInstance({ name: "infinite-canvas", storeName: "comfy_templates" });
const prefix = "v1:";
export const comfyTemplateStorageKey = (id: string, revision: string) => prefix + id + "@" + revision;

export async function listComfyTemplates(): Promise<ComfyWorkflowTemplate[]> {
    const found: ComfyWorkflowTemplate[] = [];
    await db.iterate<ComfyWorkflowTemplate, void>((value, key) => {
        if (key.startsWith(prefix) && value) found.push(value);
    });
    return found.sort((a, b) => a.name.localeCompare(b.name) || a.revision.localeCompare(b.revision));
}

export async function getComfyTemplate(id: string, revision: string): Promise<ComfyWorkflowTemplate | null> {
    const value = await db.getItem<ComfyWorkflowTemplate>(comfyTemplateStorageKey(id, revision));
    if (value) await verifyComfyTemplate(value);
    return value;
}

/** A new revision is added; existing bytes are never overwritten. */
export async function installComfyTemplate(template: ComfyWorkflowTemplate): Promise<"installed" | "existing"> {
    await verifyComfyTemplate(template);
    const key = comfyTemplateStorageKey(template.id, template.revision);
    const existing = await db.getItem<ComfyWorkflowTemplate>(key);
    if (existing) {
        await verifyComfyTemplate(existing);
        return "existing";
    }
    await db.setItem(key, structuredClone(template));
    return "installed";
}

export async function saveComfyTemplateVersion(
    id: string, payload: ComfyTemplatePayload, info?: ComfyObjectInfo,
): Promise<ComfyWorkflowTemplate> {
    const template = await createComfyTemplate(id, payload, info);
    await installComfyTemplate(template);
    return template;
}

export async function removeComfyTemplateVersion(id: string, revision: string) {
    await db.removeItem(comfyTemplateStorageKey(id, revision));
}

/** Dependency-staging rollback, not deletion of pre-existing versions. */
export async function installComfyBackupVersions(templates: readonly ComfyWorkflowTemplate[]) {
    const added: Array<{id:string;revision:string}> = [];
    try {
        for (const template of templates) {
            const status = await installComfyTemplate(template);
            if (status === "installed") added.push({ id:template.id, revision:template.revision });
        }
    } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const item of added.reverse()) {
            try { await removeComfyTemplateVersion(item.id, item.revision); }
            catch (cause) { rollbackErrors.push(cause); }
        }
        if (rollbackErrors.length) throw new AggregateError([error,...rollbackErrors], "Template install failed and rollback was incomplete");
        throw error;
    }
    return async () => {
        const errors: unknown[] = [];
        for (const item of added.reverse()) {
            try { await removeComfyTemplateVersion(item.id, item.revision); }
            catch (cause) { errors.push(cause); }
        }
        if (errors.length) throw new AggregateError(errors, "Comfy template rollback was incomplete");
    };
}
