import { lazy, Suspense, useEffect, useState } from "react";
import { Button, ConfigProvider, Input, Modal, Popconfirm, Typography } from "antd";
import { AlertCircle, Check, Clock3, FileText, History, RotateCcw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { TextVersion } from "@/features/canvas-text-versions";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

const LazyCanvasTextMarkdown = lazy(() => import("./canvas-text-markdown").then(({ CanvasTextMarkdown }) => ({ default: CanvasTextMarkdown })));
const MAX_VERSIONS = 50;

type Props = {
    open: boolean;
    versions: TextVersion[];
    currentContent: string;
    onClose: () => void;
    onSave: (note?: string) => Promise<void>;
    onDelete: (id: string) => void;
    onRestore: (version: TextVersion) => void;
    onRetryPersistence: () => Promise<void>;
    retryPending: boolean;
    busy?: boolean;
};

export function CanvasTextVersionsModal({
    open,
    versions,
    currentContent,
    onClose,
    onSave,
    onDelete,
    onRestore,
    onRetryPersistence,
    retryPending,
    busy = false,
}: Props) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [note, setNote] = useState("");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [retrying, setRetrying] = useState(false);
    const [retryFailed, setRetryFailed] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

    const selected = versions.find((version) => version.id === selectedId) ?? versions[0] ?? null;
    const isBlank = !currentContent.trim();
    const isDuplicate = !isBlank && versions[0]?.content === currentContent;
    const isFull = versions.length >= MAX_VERSIONS;
    const saveDisabled = busy || retryPending || saving || isBlank || isDuplicate || isFull;

    useEffect(() => {
        if (!open) return;
        setNote("");
        setSelectedId(versions[0]?.id ?? null);
        setSaveFailed(false);
        setDeleteConfirmOpen(false);
    }, [open]);

    useEffect(() => {
        if (selectedId && !versions.some((version) => version.id === selectedId)) {
            setSelectedId(versions[0]?.id ?? null);
        }
    }, [selectedId, versions]);

    useEffect(() => {
        setDeleteConfirmOpen(false);
    }, [selectedId]);

    const close = () => {
        if (!busy) onClose();
    };

    const handleSave = async () => {
        if (saveDisabled) return;
        setSaving(true);
        setSaveFailed(false);
        try {
            await onSave(note.trim() || undefined);
            setNote("");
        } catch {
            setSaveFailed(true);
        } finally {
            setSaving(false);
        }
    };

    const handleRetry = async () => {
        if (retrying || busy) return;
        setRetrying(true);
        try {
            await onRetryPersistence();
            setRetryFailed(false);
            setSaveFailed(false);
        } catch {
            setRetryFailed(true);
        } finally {
            setRetrying(false);
        }
    };

    const dateLabel = (value: string) => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    };

    if (!open) return null;

    return (
        <ConfigProvider
            theme={{
                token: {
                    colorBgContainer: theme.node.panel,
                    colorBgElevated: theme.node.panel,
                    colorText: theme.node.text,
                    colorTextSecondary: theme.node.muted,
                    colorBorder: theme.toolbar.border,
                    colorPrimary: theme.node.activeStroke,
                    colorTextLightSolid: theme.node.panel,
                    borderRadius: 12,
                    controlItemBgActive: theme.toolbar.activeBg,
                },
            }}
        >
            <Modal
                title={
                    <div className="flex min-w-0 items-start gap-3">
                        <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border, color: theme.node.activeStroke }}>
                            <History className="size-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="text-base font-semibold leading-6">{t("canvas.textVersions.title")}</div>
                            <div className="mt-0.5 text-xs font-normal leading-5" style={{ color: theme.node.muted }}>{t("canvas.textVersions.subtitle")}</div>
                        </div>
                    </div>
                }
                open={open}
                onCancel={close}
                closable={!busy}
                footer={null}
                centered
                width="min(960px, calc(100vw - 24px))"
                style={{ top: 0, paddingBottom: 0 }}
                destroyOnHidden
                keyboard={!busy && !deleteConfirmOpen}
                mask={{ closable: !busy }}
                styles={{
                    container: { background: theme.node.panel, border: `1px solid ${theme.node.stroke}`, borderRadius: 22, overflow: "hidden", padding: 0, display: "flex", flexDirection: "column", maxHeight: "calc(100dvh - 32px)" },
                    header: { background: theme.node.panel, borderBottom: `1px solid ${theme.node.stroke}`, margin: 0, padding: "18px 56px 18px 24px", flexShrink: 0 },
                    body: { background: theme.node.panel, padding: 0, color: theme.node.text, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
                }}
            >
                <div data-canvas-shortcuts-ignore className="flex min-h-0 flex-col" style={{ height: "min(620px, calc(100dvh - 140px))" }} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
                    <section className="shrink-0 border-b px-5 py-4 sm:px-6" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                                aria-label={t("canvas.textVersions.notePlaceholder")}
                                maxLength={100}
                                value={note}
                                onChange={(event) => { setNote(event.target.value); setSaveFailed(false); }}
                                placeholder={t("canvas.textVersions.notePlaceholder")}
                                disabled={busy || retryPending || saving}
                                style={{ minWidth: 0, background: theme.node.code.surface, borderColor: theme.toolbar.border, color: theme.node.text }}
                            />
                            <Button
                                aria-label={t("canvas.textVersions.saveCurrent")}
                                icon={<Save className="size-4" aria-hidden="true" />}
                                loading={saving}
                                disabled={saveDisabled}
                                onClick={() => void handleSave()}
                                style={{ height: 40, flexShrink: 0, background: theme.node.activeStroke, borderColor: theme.node.activeStroke, color: theme.node.fill, fontWeight: 600, opacity: saveDisabled ? 0.56 : 1 }}
                            >
                                {t("canvas.textVersions.saveCurrent")}
                            </Button>
                        </div>
                        <div className="mt-2 min-h-4 text-xs" style={{ color: saveFailed ? "#c2413b" : theme.node.muted }} role={saveFailed ? "alert" : undefined}>
                            {saveFailed ? t("canvas.textVersions.saveFailedGeneric") : isBlank ? t("canvas.textVersions.emptyCannotSave") : isDuplicate ? t("canvas.textVersions.duplicateCannotSave") : isFull ? t("canvas.textVersions.limitReached") : ""}
                        </div>
                    </section>

                    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(100px,0.4fr)_minmax(0,1fr)] overflow-hidden md:h-[min(500px,62vh)] md:grid-cols-[280px_minmax(0,1fr)] md:grid-rows-1">
                        <section className="flex min-h-0 flex-col overflow-hidden border-b md:border-b-0 md:border-r" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                            <div className="flex h-[52px] shrink-0 items-center justify-between border-b px-4 py-0" style={{ borderColor: theme.node.stroke }}>
                                <div className="text-sm font-semibold leading-5" style={{ color: theme.node.muted }}>{t("canvas.textVersions.listTitle")}</div>
                                <span className="text-xs tabular-nums" style={{ color: theme.node.faint }}>{t("canvas.textVersions.count", { count: versions.length, max: MAX_VERSIONS })}</span>
                            </div>
                            <div aria-label={t("canvas.textVersions.listTitle")} className="max-h-44 min-h-0 flex-1 overflow-y-auto p-2 md:max-h-none">
                                {versions.length ? versions.map((version) => {
                                    const isSelected = selected?.id === version.id;
                                    const matchesCurrent = version.content === currentContent;
                                    return (
                                        <button
                                            key={version.id}
                                            type="button"
                                            disabled={busy || retryPending}
                                            aria-current={isSelected ? "true" : undefined}
                                            aria-label={version.note || t(version.source === "manual" ? "canvas.textVersions.manual" : "canvas.textVersions.restoreBackup")}
                                            onClick={() => { setDeleteConfirmOpen(false); setSelectedId(version.id); }}
                                            className="mb-2 block w-full rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed"
                                            style={{ background: isSelected ? theme.toolbar.activeBg : "transparent", borderColor: isSelected ? theme.node.activeStroke : theme.node.stroke, color: theme.node.text, boxShadow: isSelected ? `inset 0 0 0 1px ${theme.node.activeStroke}22` : undefined }}
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <span className="min-w-0 truncate text-sm font-medium">{version.note || t(version.source === "manual" ? "canvas.textVersions.manual" : "canvas.textVersions.restoreBackup")}</span>
                                                {matchesCurrent ? <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: theme.node.panel, color: theme.node.muted }}><Check className="size-3" aria-hidden="true" />{t("canvas.textVersions.currentVersion")}</span> : null}
                                            </div>
                                            <div className="mt-1 flex items-center gap-1 text-[11px]" style={{ color: theme.node.muted }}><Clock3 className="size-3" aria-hidden="true" /><span>{dateLabel(version.createdAt)}</span></div>
                                            <Typography.Paragraph ellipsis={{ rows: 2 }} className="!mb-0 !mt-2 text-xs" style={{ color: theme.node.muted }}>{version.content.replace(/\s+/g, " ").trim()}</Typography.Paragraph>
                                            <span className="mt-2 inline-flex rounded-md border px-1.5 py-0.5 text-[10px]" style={{ borderColor: theme.node.stroke, color: theme.node.faint }}>{t(version.source === "manual" ? "canvas.textVersions.manual" : "canvas.textVersions.restoreBackup")}</span>
                                        </button>
                                    );
                                }) : (
                                    <div className="flex h-full min-h-28 flex-col items-center justify-center px-4 py-6 text-center" style={{ color: theme.node.muted }}>
                                        <History className="mb-2 size-6 opacity-60" aria-hidden="true" />
                                        <div className="text-sm font-medium">{t("canvas.textVersions.noVersionsTitle")}</div>
                                        <div className="mt-1 text-xs leading-5">{t("canvas.textVersions.noVersionsHint")}</div>
                                    </div>
                                )}
                            </div>
                        </section>

                        <section className="flex min-h-0 flex-col overflow-hidden" style={{ background: theme.node.panel }}>
                            <div className="flex h-[52px] shrink-0 items-center justify-between gap-3 border-b px-4 py-0 sm:px-5" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold">{selected?.note || (selected ? t(selected.source === "manual" ? "canvas.textVersions.manual" : "canvas.textVersions.restoreBackup") : t("canvas.textVersions.previewTitle"))}</div>
                                    {selected ? <div className="mt-1 flex items-center gap-1 text-[11px] leading-4" style={{ color: theme.node.muted }}><Clock3 className="size-3" aria-hidden="true" />{dateLabel(selected.createdAt)}</div> : null}
                                </div>
                                {selected ? <span className="shrink-0 text-xs tabular-nums" style={{ color: theme.node.muted }}>{t("canvas.textVersions.characterCount", { count: selected.content.length })}</span> : null}
                            </div>
                            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5" style={{ background: theme.node.panel, color: theme.node.text }}>
                                {selected ? <Suspense fallback={<div className="whitespace-pre-wrap text-sm">{selected.content}</div>}><LazyCanvasTextMarkdown content={selected.content} theme={theme} /></Suspense> : (
                                    <div className="flex h-full min-h-0 flex-col items-center justify-center text-center" style={{ color: theme.node.muted }}>
                                        <FileText className="mb-3 size-8 opacity-50" aria-hidden="true" />
                                        <div className="text-sm font-medium">{t("canvas.textVersions.empty")}</div>
                                        <div className="mt-1 max-w-xs text-xs leading-5">{t("canvas.textVersions.noSelectionHint")}</div>
                                    </div>
                                )}
                            </div>
                            {(retryPending || retryFailed) ? (
                                <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5 sm:px-5" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                                    <div role="alert" className="flex min-w-0 items-center gap-2 text-xs" style={{ color: theme.node.muted }}><AlertCircle className="size-4 shrink-0" style={{ color: "#c2413b" }} aria-hidden="true" /><span className="truncate">{t("canvas.textVersions.saveFailedGeneric")}</span></div>
                                    <Button size="small" loading={retrying} disabled={retrying || busy} onClick={() => void handleRetry()}>{t("canvas.textVersions.retry")}</Button>
                                </div>
                            ) : null}
                            <div className="flex shrink-0 items-center justify-between gap-2 border-t px-4 py-3 sm:px-5" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                                <Popconfirm open={deleteConfirmOpen} title={t("canvas.textVersions.deleteConfirm")} onOpenChange={setDeleteConfirmOpen} onConfirm={() => onDelete(selected!.id)}>
                                    <Button
                                        aria-label={t("common.delete")}
                                        disabled={busy || retryPending || !selected}
                                        icon={<Trash2 className="size-4" aria-hidden="true" />}
                                        style={{ borderColor: theme.node.stroke, color: "#b4534b", background: theme.node.panel }}
                                    >{t("common.delete")}</Button>
                                </Popconfirm>
                                <Button
                                    aria-label={t("common.restore")}
                                    type="primary"
                                    disabled={busy || retryPending || !selected || !selected.content.trim() || selected.content === currentContent}
                                    icon={<RotateCcw className="size-4" aria-hidden="true" />}
                                    onClick={() => selected && onRestore(selected)}
                                    style={{ background: theme.node.activeStroke, borderColor: theme.node.activeStroke, color: theme.node.panel, fontWeight: 600, opacity: busy || retryPending || !selected || !selected.content.trim() || selected.content === currentContent ? 0.56 : 1 }}
                                >{t("common.restore")}</Button>
                            </div>
                        </section>
                    </div>
                </div>
            </Modal>
        </ConfigProvider>
    );
}
