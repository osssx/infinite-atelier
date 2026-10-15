import type { SeedanceVideoMode } from "@/stores/use-config-store";
import type { CanvasVideoReference } from "@/types/canvas";

type MediaInput = Pick<CanvasVideoReference, "id" | "kind">;
type Role = CanvasVideoReference["role"];

const referenceRoles: Record<MediaInput["kind"], NonNullable<Role>> = {
    image: "reference_image",
    video: "reference_video",
    audio: "reference_audio",
};

/**
 * The config UI and request builder must derive the same default roles.
 * A saved role-less entry means explicitly excluded; an unsaved input is new.
 */
export function resolveSeedanceInputAssignments(
    mode: SeedanceVideoMode,
    inputs: readonly MediaInput[],
    saved: readonly CanvasVideoReference[] = [],
): CanvasVideoReference[] {
    const byId = new Map(inputs.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const ordered: MediaInput[] = [];
    for (const item of saved) {
        const input = byId.get(item.id);
        if (!input || seen.has(item.id)) continue;
        seen.add(item.id);
        ordered.push(input);
    }
    for (const item of inputs) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        ordered.push(item);
    }
    const savedById = new Map(saved.map((item) => [item.id, item]));
    const eligible = ordered.filter((item) => {
        const entry = savedById.get(item.id);
        return !entry || Boolean(entry.role);
    });
    const images = eligible.filter((item) => item.kind === "image");
    const preferredFirst = images.find((item) => savedById.get(item.id)?.role === "first_frame")?.id;
    const preferredLast = images.find((item) => savedById.get(item.id)?.role === "last_frame")?.id;
    const firstId = mode === "first_last_frame"
        ? preferredFirst || images.find((item) => item.id !== preferredLast)?.id || images[0]?.id
        : preferredFirst || images[0]?.id;
    const lastId = preferredLast !== firstId
        ? preferredLast || images.find((item) => item.id !== firstId)?.id
        : images.find((item) => item.id !== firstId)?.id;

    return ordered.map((item) => {
        const entry = savedById.get(item.id);
        let role: Role;
        if (entry && !entry.role) role = undefined;
        else if (mode === "omni_reference") role = referenceRoles[item.kind];
        else if (mode === "first_frame") role = item.kind === "image" && item.id === firstId ? "first_frame" : undefined;
        else if (mode === "first_last_frame") {
            role = item.kind !== "image" ? undefined : item.id === firstId ? "first_frame" : item.id === lastId ? "last_frame" : undefined;
        }
        return { id: item.id, kind: item.kind, role };
    });
}

/** Text-to-video may run with connected media only if they were explicitly excluded. */
export function assertSeedanceTextModeReferences(
    inputs: readonly MediaInput[],
    saved: readonly CanvasVideoReference[] = [],
) {
    const excluded = new Set(saved.filter((item) => !item.role).map((item) => item.id));
    if (inputs.some((item) => !excluded.has(item.id))) {
        throw new Error("Connected reference media would be ignored in text-to-video mode. Select first-frame or reference-video mode, or explicitly exclude the media in the configuration node.");
    }
}
