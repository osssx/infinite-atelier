import { useState, type CSSProperties } from "react";
import { Box, ChevronRight, Mountain, Plus, Trash2, UserRound } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { DramaAsset, DramaAssetKind } from "./canvas-drama-pipeline";

const kinds: Record<DramaAssetKind, string> = {character:"角色", scene:"场景", prop:"道具"};
const kindIcons = {character:UserRound, scene:Mountain, prop:Box};
const fieldClass = "w-full min-w-0 rounded-lg border px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1";

export function DramaAssetFields({assets, theme, expanded, disabled, onChange}: {
    assets: DramaAsset[];
    theme: CanvasTheme;
    expanded: boolean;
    disabled: boolean;
    onChange: (assets: DramaAsset[]) => void;
}) {
    const [kind, setKind] = useState<DramaAssetKind>("character");
    const [activeId, setActiveId] = useState("");
    const rows = assets.filter(asset => asset.kind === kind);
    const active = rows.find(asset => asset.id === activeId) ?? rows[0];
    const edit = (patch: Partial<DramaAsset>) => onChange(assets.map(asset =>
        asset === active ? {...asset, ...patch} : asset));
    const variants = active?.variants ?? [];
    const surface: CSSProperties = {background:theme.node.panel, borderColor:theme.node.stroke};
    const control: CSSProperties = {...surface, color:theme.node.text, outlineColor:theme.node.activeStroke};
    const selected: CSSProperties = {background:theme.toolbar.activeBg, color:theme.toolbar.activeText, borderColor:theme.node.muted};
    const addAsset = () => {
        const id = `${kind}_${crypto.randomUUID()}`;
        onChange([...assets, {id, kind, name:"", description:"", sourceRefs:[],
            ...(kind === "character" ? {variants:[{id:`outfit_${crypto.randomUUID()}`,name:"默认造型",description:""}]} : {})}]);
        setActiveId(id);
    };
    return <fieldset disabled={disabled} className="min-w-0 space-y-3">
        <div className="grid grid-cols-3 gap-1.5 rounded-xl border p-1.5" style={surface} role="group" aria-label="资产类别">
            {(Object.keys(kinds) as DramaAssetKind[]).map(item => {
                const Icon = kindIcons[item];
                return <button key={item} type="button" aria-pressed={kind === item}
                    className="flex min-w-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-1 py-2 font-medium hover:opacity-75"
                    style={kind === item ? selected : {color:theme.node.muted}} onClick={() => setKind(item)}>
                    <Icon aria-hidden className="size-4 shrink-0" />
                    {kinds[item]}
                    <span className="tabular-nums opacity-70">{assets.filter(asset => asset.kind === item).length}</span>
                </button>;
            })}
        </div>
        <div className={expanded ? "grid items-start gap-4 md:grid-cols-[minmax(180px,0.8fr)_minmax(0,2fr)] lg:gap-6" : "space-y-3"}>
        {expanded ? <div className="space-y-3 rounded-xl border p-3" style={surface}>
            <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{kinds[kind]}列表</h3>
                <button type="button" className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 hover:opacity-75" style={control} onClick={addAsset}><Plus className="size-4" />添加</button>
            </div>
            <div className="grid max-h-56 gap-1.5 overflow-y-auto md:max-h-[52dvh]" aria-label={`${kinds[kind]}列表`}>
                {rows.map(asset => <button type="button" key={asset.id} aria-pressed={active === asset}
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-transparent px-3 py-2.5 text-left hover:opacity-75"
                    style={active === asset ? selected : undefined} onClick={() => setActiveId(asset.id)}>
                    <span className="min-w-0 flex-1 truncate">{asset.name || "未命名"}</span>
                    {active === asset && <ChevronRight aria-hidden className="size-4 shrink-0" />}
                </button>)}
                {!rows.length && <p className="px-2 py-3" style={{color:theme.node.muted}}>暂无{kinds[kind]}</p>}
            </div>
        </div> : <div className="flex gap-2">
            <select aria-label={`选择${kinds[kind]}`} className={fieldClass} style={control} value={active?.id ?? ""}
                onChange={event => setActiveId(event.target.value)}>
                {rows.length ? rows.map(asset => <option key={asset.id} value={asset.id}>{asset.name || "未命名"}</option>) : <option value="">暂无{kinds[kind]}</option>}
            </select>
            <button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 hover:opacity-75" style={control} onClick={addAsset}><Plus className="size-3.5" />添加</button>
        </div>}
        {active && <div className={`min-w-0 space-y-3 rounded-xl border ${expanded ? "p-5" : "p-3"}`} style={surface}>
            <div className="flex items-center justify-between gap-2">
                <h3 className="truncate font-semibold">{active.name || `新${kinds[kind]}`}</h3>
                <button type="button" className="inline-grid size-8 shrink-0 place-items-center rounded-lg hover:opacity-75" title="从草案删除"
                aria-label={`删除${kinds[kind]}${active.name ? `：${active.name}` : ""}`}
                onClick={() => {
                    onChange(assets.filter(asset => asset !== active));
                    setActiveId("");
                }}><Trash2 className="size-4" /></button>
            </div>
            <label className="grid gap-1.5 font-medium">名称
                <input className={fieldClass} style={control} value={active.name} maxLength={240}
                    onChange={event => edit({name:event.target.value})} />
            </label>
            <label className="grid gap-1.5 font-medium">描述
                <textarea className={`${fieldClass} resize-y font-normal leading-relaxed`} style={control} value={active.description} rows={expanded ? 6 : 3} maxLength={20000}
                    onChange={event => edit({description:event.target.value})} />
            </label>
            {active.sourceRefs.length > 0 && <p className="break-words text-xs" style={{color:theme.node.muted}}>原文出处 {active.sourceRefs.join("、")}</p>}
            {kind !== "prop" && <details key={active.id} className="space-y-3 border-t pt-3" style={{borderColor:theme.node.stroke}}>
                <summary className="cursor-pointer font-medium">{kind === "character" ? "造型" : "场景变体"} · {variants.length}</summary>
                {variants.map((variant, index) => <div key={variant.id} className="space-y-2 rounded-lg border p-3" style={{background:theme.node.code.surface,borderColor:theme.node.stroke}}>
                    <input aria-label={`变体 ${index + 1} 名称`} className={fieldClass} style={control} maxLength={240} value={variant.name}
                        onChange={event => edit({variants:variants.map(item => item === variant ? {...item, name:event.target.value} : item)})} />
                    <textarea aria-label={`变体 ${index + 1} 描述`} className={fieldClass} style={control} maxLength={20000} value={variant.description}
                        onChange={event => edit({variants:variants.map(item => item === variant ? {...item, description:event.target.value} : item)})} />
                </div>)}
                <button type="button" disabled={variants.length >= 32} className="rounded-md border px-2 py-1" style={control}
                    onClick={() => edit({variants:[...variants, {id:`variant_${crypto.randomUUID()}`,name:"",description:""}]})}>添加{kind === "character" ? "造型" : "变体"}</button>
            </details>}
        </div>}
        </div>
    </fieldset>;
}
