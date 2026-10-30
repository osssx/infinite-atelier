import { App, Button, Empty, Input, Modal, Select, Switch } from "antd";
import { Download, Eye, RefreshCw } from "lucide-react";
import { saveAs } from "file-saver";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { exportSkill, getSkillPackage, getSkillStorageConfig, SKILL_REGISTRY_CHANNEL } from "./skill-registry";
import { useSkillStore } from "@/stores/use-skill-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function SkillManager() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [query, setQuery] = useState("");
    const [directory, setDirectory] = useState<string | null>(null);
    const [preview, setPreview] = useState<{ title: string; text: string } | null>(null);
    const catalog = useSkillStore((state) => state.catalog);
    const loaded = useSkillStore((state) => state.loaded);
    const busy = useSkillStore((state) => state.busy);
    const scan = useSkillStore((state) => state.scan);
    const scanResult = useSkillStore((state) => state.scanResult);
    const refresh = useSkillStore((state) => state.refresh);
    const toggle = useSkillStore((state) => state.toggle);
    const changeVersion = useSkillStore((state) => state.changeVersion);
    const changeScope = useSkillStore((state) => state.changeScope);
    const projects = useCanvasStore((state) => state.projects);
    const scopeOptions = [
        { value: "global", label: t("config.skills.scopeGlobal") },
        ...projects.map((project) => ({ value: "project:" + project.id, label: project.title || project.id })),
    ];
    useEffect(() => { void refresh().catch((error) => message.error(String(error))); }, [refresh, message]);
    useEffect(() => { void getSkillStorageConfig().then((config) => setDirectory(config.directory)).catch(() => setDirectory(null)); }, []);
    useEffect(() => {
        const sync = () => { void refresh().catch(() => {
            // Avoid recurring toasts while offline; explicit actions show errors.
        }); };
        const onVisibility = () => {
            if (document.visibilityState === "visible") sync();
        };
        window.addEventListener("focus", sync);
        document.addEventListener("visibilitychange", onVisibility);
        const poll = window.setInterval(() => {
            if (document.visibilityState === "visible") sync();
        }, 10000);
        let channel: BroadcastChannel | null = null;
        if (typeof BroadcastChannel !== "undefined") {
            try {
                channel = new BroadcastChannel(SKILL_REGISTRY_CHANNEL);
                channel.onmessage = event => {
                    if(event.data && event.data.kind === "changed") sync();
                };
            } catch { /* visibility and polling remain available */ }
        }
        return () => {
            window.removeEventListener("focus", sync);
            document.removeEventListener("visibilitychange", onVisibility);
            window.clearInterval(poll);
            channel?.close();
        };
    }, [refresh]);
    const execute = async (action: () => Promise<unknown>, success?: string) => {
        try { await action(); if (success) message.success(success); }
        catch (error) { message.error(error instanceof Error ? error.message : String(error)); }
    };
    const visible = catalog.filter((skill) => (skill.name + " " + skill.description).toLowerCase().includes(query.toLowerCase()));
    return (
        <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="max-w-xl text-xs text-stone-500">{t("config.skills.description")}</div>
                <Button loading={busy} disabled={busy} icon={<RefreshCw className="size-4" />} onClick={() => void execute(() => scan())}>{t("config.skills.scan")}</Button>
            </div>
            <div className="break-all rounded-lg bg-stone-100 p-3 text-xs dark:bg-stone-900">
                <div className="mb-1 opacity-60">{t("config.skills.directory")}</div>
                <code>{directory || "ATELIER_SKILLS_DIR"}</code>
            </div>
            {scanResult && <div className="space-y-1 text-xs" role="status">
                <div>{t("config.skills.scanSummary", scanResult)}</div>
                {scanResult.errors.length > 0 && <div className="text-red-500">{t("config.skills.scanErrors")}: {scanResult.errors.map(error => error.id + ": " + error.code).join("; ")}</div>}
            </div>}
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
                        <Select size="small" disabled={busy} value={skill.scope?.type === "project" ? "project:" + skill.scope.projectId : "global"}
                            aria-label={t("config.skills.scopeLabel")}
                            options={skill.scope?.type === "project" && !projects.some((project) => project.id === (skill.scope?.type === "project" ? skill.scope.projectId : undefined))
                                ? [...scopeOptions, { value: "project:" + skill.scope.projectId, label: t("config.skills.missingProject") + " (" + skill.scope.projectId + ")" }]
                                : scopeOptions}
                            onChange={(scopeId) => void execute(() => changeScope(skill.id, scopeId === "global" ? { type: "global" } : { type: "project", projectId: scopeId.slice(8) }))}
                            style={{ minWidth: 148, maxWidth: 220 }} />
                        <Select size="small" disabled={busy} value={skill.activeVersion} options={skill.versions.map((version) => ({ value: version, label: version }))} onChange={(version) => void execute(() => changeVersion(skill.id, version))} style={{ minWidth: 144 }} />
                        <Button size="small" icon={<Eye className="size-3.5" />} onClick={() => void execute(async () => {
                            const data = await getSkillPackage(skill.id);
                            if (data) setPreview({ title: skill.name + " @ " + skill.activeVersion, text: data.skillMd });
                        })}>{t("config.skills.preview")}</Button>
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void execute(async () => saveAs(await exportSkill(skill.id), skill.name + "-" + skill.activeVersion + ".zip"))}>{t("config.skills.export")}</Button>
                    </div>
                </div>
            ))}
            <Modal title={preview?.title} open={Boolean(preview)} onCancel={() => setPreview(null)} onOk={() => setPreview(null)} footer={null} width={750} destroyOnHidden>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-stone-100 p-4 text-xs dark:bg-stone-900">{preview?.text || ""}</pre>
            </Modal>
        </section>
    );
}
