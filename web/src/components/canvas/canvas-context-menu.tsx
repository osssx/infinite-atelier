import { useEffect } from "react";
import type { ReactNode } from "react";
import { ClipboardPaste, Copy, Plus, Trash2, Unlink2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "@/types/canvas";

export function CanvasNodeContextMenu({ menu, onClose, onDuplicate, onDelete, onCopyText, onPasteText }: { menu: ContextMenuState; onClose: () => void; onDuplicate: () => void; onDelete: () => void; onCopyText: () => void; onPasteText: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {menu.type === "text" ? (
                <>
                    <MenuButton icon={<Copy className="size-4" />} label={t("canvas.controls.copyText")}
                        onClick={onCopyText} disabled={!menu.editor.copyValue} preserveEditorFocus />
                    <MenuButton icon={<ClipboardPaste className="size-4" />} label={t("canvas.controls.pasteText")}
                        onClick={onPasteText} disabled={menu.editor.input.readOnly} preserveEditorFocus />
                </>
            ) : (
                <>
                    {menu.type === "node" ? <MenuButton icon={<Plus className="size-4" />} label={t("canvas.controls.duplicate")} onClick={onDuplicate} /> : null}
                    <MenuButton icon={menu.type === "connection" ? <Unlink2 className="size-4" /> : <Trash2 className="size-4" />} label={t(menu.type === "connection" ? "canvas.controls.disconnect" : "canvas.controls.delete")} onClick={onDelete} danger />
                </>
            )}
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false, disabled = false, preserveEditorFocus = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean; disabled?: boolean; preserveEditorFocus?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" disabled={disabled} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40" style={{ color: danger ? "#f87171" : theme.node.text }} onMouseDown={preserveEditorFocus ? (event) => event.preventDefault() : undefined} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
