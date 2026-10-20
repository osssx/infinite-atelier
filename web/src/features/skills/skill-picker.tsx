import { Select, Segmented } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSkillStore } from "@/stores/use-skill-store";
import type { SkillBinding } from "./types";

export function SkillPicker({ binding, onChange }: { binding?: SkillBinding; onChange: (next: SkillBinding) => void }) {
    const { t } = useTranslation();
    const loaded = useSkillStore((state) => state.loaded);
    const catalog = useSkillStore((state) => state.catalog);
    const refresh = useSkillStore((state) => state.refresh);
    useEffect(() => { if (!loaded) void refresh().catch(() => undefined); }, [loaded, refresh]);

    const selection = binding || { mode: "off", skillIds: [] };
    const options = catalog.map((entry) => ({
        label: entry.name + (entry.enabled ? "" : " (" + t("config.skills.disabled") + ")"),
        value: entry.id,
        disabled: !entry.enabled,
    }));
    const known = new Set(catalog.map((entry) => entry.id));
    for (const id of selection.skillIds) if (!known.has(id)) options.push({ label: id + " (" + t("canvas.skillPicker.missing") + ")", value: id, disabled: true });

    return (
        <div className="mb-2 min-w-0 cursor-default rounded-lg border border-stone-200/80 p-2 dark:border-stone-700/80" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mb-1.5 text-[11px] font-medium">{t("canvas.skillPicker.title")}</div>
            <Segmented size="small" value={selection.mode} options={[
                { value: "off", label: t("canvas.skillPicker.off") },
                { value: "manual", label: t("canvas.skillPicker.manual") },
                { value: "auto", label: t("canvas.skillPicker.auto"), disabled: true },
            ]} onChange={(mode) => onChange({ mode: mode as SkillBinding["mode"], skillIds: [...selection.skillIds] })} />
            {selection.mode === "manual" && (
                <Select
                    mode="multiple"
                    className="mt-2 w-full"
                    size="small"
                    value={selection.skillIds}
                    maxTagCount="responsive"
                    placeholder={t("canvas.skillPicker.placeholder")}
                    options={options}
                    onChange={(skillIds) => onChange({ mode: "manual", skillIds })}
                    allowClear
                />
            )}
            <div className="mt-1.5 text-[10px] opacity-60">{t("canvas.skillPicker.hint")}</div>
        </div>
    );
}
