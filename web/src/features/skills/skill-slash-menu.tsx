import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { canvasThemes } from "@/lib/canvas-theme";
import { keepMentionOptionVisible } from "@/lib/canvas/canvas-mention-position";
import { skillSlashMenuPlacement } from "./skill-slash-position";
import type { SkillCatalogEntry } from "./types";

export function SkillSlashMenu({ entries, activeIndex, rect, theme, onSelect }: {
    entries: SkillCatalogEntry[];
    activeIndex: number;
    rect: DOMRect | null;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onSelect: (entry: SkillCatalogEntry) => void;
}) {
    const { t } = useTranslation();
    const selectedRef = useRef(false);
    const activeRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    // scrollIntoView also scrolls page/overlay ancestors and shifts the caret anchor.
    useEffect(() => { keepMentionOptionVisible(menuRef.current, activeRef.current); }, [activeIndex, entries]);
    const choose = (entry: SkillCatalogEntry) => {
        if (selectedRef.current) return;
        selectedRef.current = true;
        onSelect(entry);
    };
    const stop = (event: PointerEvent | MouseEvent) => event.stopPropagation();
    const anchor = rect || new DOMRect(16, 16, 0, 0);
    const placement = skillSlashMenuPlacement(anchor, { width: window.innerWidth, height: window.innerHeight }, entries.length);
    return createPortal(
        <div
            data-skill-slash-menu="true"
            ref={menuRef}
            className="fixed z-[1200] overflow-y-auto rounded-xl border p-1 shadow-2xl backdrop-blur-md"
            style={{ ...placement, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={stop} onMouseDown={stop} onClick={(event) => event.stopPropagation()}
        >
            {entries.length ? entries.map((entry, index) => (
                <button
                    key={entry.id} ref={index === activeIndex ? activeRef : undefined}
                    type="button" className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs"
                    style={{ background: index === activeIndex ? theme.toolbar.activeBg : "transparent", color: index === activeIndex ? theme.toolbar.activeText : theme.node.text }}
                    onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); choose(entry); }}
                    onClick={(event) => { event.preventDefault(); event.stopPropagation(); choose(entry); }}
                >
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-black/10"><BookOpen className="size-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold leading-5">/{entry.name}</span><span className="block truncate text-[11px] leading-4 opacity-65">{entry.description}</span></span>
                </button>
            )) : <div className="p-2 text-xs opacity-70">{t("canvas.skillPicker.noMatches")}</div>}
        </div>,
        document.body,
    );
}
