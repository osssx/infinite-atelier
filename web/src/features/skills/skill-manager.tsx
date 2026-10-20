import { App, Button, Empty, Input, Modal, Popconfirm, Select, Switch } from "antd";
import { Download, Eye, FileUp, Trash2 } from "lucide-react";
import { saveAs } from "file-saver";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { exportSkill, getSkillPackage } from "./skill-registry";
import { useSkillStore } from "@/stores/use-skill-store";

export function SkillManager() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [query, setQuery] = useState("");
    const [preview, setPreview] = useState<{ title: string; text: string } | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const catalog = useSkillStore((state) => state.catalog);
    const loaded = useSkillStore((state) => state.loaded);
    const busy = useSkillStore((state) => state.busy);
    const refresh = useSkillStore((state) => state.refresh);
    const importFile = useSkillStore((state) => state.importFile);
    const toggle = useSkillStore((state) => state.toggle);
    const remove = useSkillStore((state) => state.remove);
    const changeVersion = useSkillStore((state) => state.changeVersion);
    useEffect(() => { void refresh().catch((error) => message.error(String(error))); }, [refresh, message]);
    const execute = async (action: () => Promise<unknown>, success?: string) => {
        try { await action(); if (success) message.success(success); }
        catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
    };
    const selectFile = async (file?: File) => {
        if (!file) return;
        try { await execute(() => importFile(file), t("config.skills.imported")); }
        finally { if (fileRef.current) fileRef.current.value = ""; }
    };
    const visible = catalog.filter((skill) => (skill.name + " " + skill.description).toLowerCase().includes(query.toLowerCase()));
    return (
        <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="max-w-xl text-xs text-stone-500">{t("config.skills.description")}</div>
                <Button loading={busy} disabled={busy} icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()}>{t("config.skills.import")}</Button>
                <input ref={fileRef} type="file" className="hidden" accept=".zip,.md,application/zip,text/markdown" onChange={(event) => void selectFile(event.target.files?.[0])} />
            </div>
            <Input.Search value={query} placeholder={t("config.skills.search")} onChange={(event) => setQuery(event.target.value)} allowClear />
            {!loaded || visible.length === 0 ? <Empty description={loaded ? t("config.skills.empty") : t("config.skills.loading")} /> : visible.map((skill) => (
                <div key={skill.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold">{skill.name}</div>
                            <div className="mt-1 text-xs text-stone-500">{skill.description}</div>
                        </div>
                        <Switch disabled={busy} checked={skill.enabled} checkedChildren={t("config.skills.enabled")} unCheckedChildren={t("config.skills.disabled")} onChange={(checked) => void execute(() => toggle(skill.id, checked))} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Select size="small" disabled={busy} value={skill.activeVersion} options={skill.versions.map((version) => ({ value: version, label: version }))} onChange={(version) => void execute(() => changeVersion(skill.id, version))} style={{ minWidth: 144 }} />
                        <Button size="small" icon={<Eye className="size-3.5" />} onClick={() => void execute(async () => {
                            const data = await getSkillPackage(skill.id);
                            if (data) setPreview({ title: skill.name + " @ " + skill.activeVersion, text: data.skillMd });
                        })}>{t("config.skills.preview")}</Button>
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void execute(async () => saveAs(await exportSkill(skill.id), skill.name + "-" + skill.activeVersion + ".zip"))}>{t("config.skills.export")}</Button>
                        <Popconfirm title={t("config.skills.confirmRemove")} onConfirm={() => void execute(() => remove(skill.id))}>
                            <Button danger disabled={busy} size="small" icon={<Trash2 className="size-3.5" />}>{t("config.skills.remove")}</Button>
                        </Popconfirm>
                    </div>
                </div>
            ))}
            <Modal title={preview?.title} open={Boolean(preview)} onCancel={() => setPreview(null)} onOk={() => setPreview(null)} footer={null} width={750} destroyOnHidden>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-stone-100 p-4 text-xs dark:bg-stone-900">{preview?.text || ""}</pre>
            </Modal>
        </section>
    );
}
