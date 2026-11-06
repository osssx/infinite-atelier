import { useState } from "react";
import { Button, Input, Modal, Tooltip } from "antd";
import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { brandPrompts, getPromptLocale } from "@/constant/prompt-library";
import { useAssetStore } from "@/stores/use-asset-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasPromptLibrary({ onSelect }: { onSelect: (prompt: string) => void }) {
    const { i18n } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const assets = useAssetStore((state) => state.assets);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const locale = getPromptLocale(i18n.resolvedLanguage);
    const prompts = [
        ...brandPrompts.map((item) => ({ id: item.id, title: item.title[locale], prompt: item.prompt[locale] })),
        ...assets.flatMap((asset) => asset.kind === "text" && asset.metadata?.promptLibraryCustom === true ? [{ id: asset.id, title: asset.title, prompt: asset.data.content }] : []),
    ].filter((item) => `${item.title} ${item.prompt}`.toLowerCase().includes(query.toLowerCase()));
    return <>
        <Tooltip title="提示词库"><Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<BookOpen className="size-3.5" />} onClick={() => setOpen(true)} aria-label="提示词库" /></Tooltip>
        <Modal title="提示词库" open={open} onCancel={() => setOpen(false)} footer={null} width={640}>
            <Input placeholder="搜索提示词" value={query} onChange={(event) => setQuery(event.target.value)} allowClear />
            <div className="thin-scrollbar mt-3 max-h-[52dvh] space-y-2 overflow-y-auto">{prompts.map((item) => <button type="button" key={item.id} className="block w-full rounded-xl border border-current/10 p-3 text-left hover:bg-black/5 dark:hover:bg-white/10" onClick={() => { onSelect(item.prompt); setOpen(false); }}><div className="text-sm font-medium">{item.title}</div><div className="mt-1 line-clamp-2 text-xs opacity-60">{item.prompt}</div></button>)}{!prompts.length ? <div className="p-6 text-center opacity-60">暂无匹配的提示词</div> : null}</div>
        </Modal>
    </>;
}
