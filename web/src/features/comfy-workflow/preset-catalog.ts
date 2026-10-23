import { krea2TurboBundledTemplate, KREA2_TURBO_TEMPLATE_ID } from "./krea2-turbo-preset";
import { createComfyTemplate, type ComfyWorkflowTemplate } from "./template-schema";
import { installComfyTemplate } from "./template-registry";
import {
    listComfyPresets, saveComfyPreset, type ComfyPreset,
} from "./preset-registry";

/** Display model shared by the global settings list and canvas binding picker. */
export type ComfyCatalogPreset = ComfyPreset & {
    builtIn: boolean;
    modified: boolean;
    defaultRevision?: string;
};

let bundledKreaTemplate: Promise<ComfyWorkflowTemplate> | undefined;
/** Calculate the immutable default once without persisting it just to display a row. */
export function bundledKrea2Template(): Promise<ComfyWorkflowTemplate> {
    return bundledKreaTemplate ??= createComfyTemplate(
        KREA2_TURBO_TEMPLATE_ID, krea2TurboBundledTemplate(),
    );
}

/** Install the exact built-in template on demand for editing or execution. */
export async function installBundledKrea2Template(): Promise<ComfyWorkflowTemplate> {
    const template = await bundledKrea2Template();
    await installComfyTemplate(template);
    return template;
}

/** One visible row per bundled template; old immutable revisions are not enumerated. */
export async function listComfyPresetCatalog(): Promise<ComfyCatalogPreset[]> {
    const [managed, bundled] = await Promise.all([listComfyPresets(), bundledKrea2Template()]);
    // Saving an edited built-in may also replace its underlying graph and templateId.
    // Keep the stable built-in alias as the identity, so reset is still available.
    const override = managed.find(p => p.id === KREA2_TURBO_TEMPLATE_ID) ??
        managed.find(p => p.templateId === KREA2_TURBO_TEMPLATE_ID);
    return [
        {
            id: override?.id ?? bundled.id,
            name: override?.name ?? bundled.name,
            templateId: override?.templateId ?? bundled.id,
            revision: override?.revision ?? bundled.revision,
            builtIn: true,
            modified: Boolean(override &&
                (override.templateId !== bundled.id || override.revision !== bundled.revision || override.name !== bundled.name)),
            defaultRevision: bundled.revision,
        },
        ...managed.filter(p => p !== override && p.templateId !== KREA2_TURBO_TEMPLATE_ID)
            .map(p => ({...p, builtIn:false, modified:false})),
    ];
}

/** Restore only the current preset pointer; pinned canvas revisions remain untouched. */
export async function resetBundledComfyPreset(): Promise<ComfyPreset> {
    const [template, managed] = await Promise.all([
        installBundledKrea2Template(), listComfyPresets(),
    ]);
    const override=managed.find(p => p.id === KREA2_TURBO_TEMPLATE_ID) ??
        managed.find(p => p.templateId === KREA2_TURBO_TEMPLATE_ID);
    const restored={
        id: override?.id ?? KREA2_TURBO_TEMPLATE_ID,
        name: template.name,
        templateId: template.id,
        revision: template.revision,
    };
    await saveComfyPreset(restored);
    return restored;
}
