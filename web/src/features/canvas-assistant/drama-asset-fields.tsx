import { useState, type CSSProperties } from "react";
import type { DramaAsset, DramaAssetKind } from "./canvas-drama-pipeline";

const kinds: Record<DramaAssetKind, string> = {character:"角色", scene:"场景", prop:"道具"};
const fieldClass = "w-full min-w-0 rounded-md border px-2 py-1";

export function DramaAssetFields({assets, control, disabled, onChange}: {
    assets: DramaAsset[];
    control: CSSProperties;
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
    return <fieldset disabled={disabled} className="min-w-0 space-y-2">
        <div className="grid grid-cols-3 gap-1" aria-label="资产类别">
            {(Object.keys(kinds) as DramaAssetKind[]).map(item => <button key={item} type="button"
                aria-pressed={kind === item} className={`rounded-md border px-1 py-1 ${kind === item ? "font-semibold ring-1 ring-current" : ""}`}
                style={control} onClick={() => setKind(item)}>
                {kinds[item]} {assets.filter(asset => asset.kind === item).length}
            </button>)}
        </div>
        <div className="flex gap-2">
            <select aria-label={`选择${kinds[kind]}`} className={fieldClass} style={control} value={active?.id ?? ""}
                onChange={event => setActiveId(event.target.value)}>
                {rows.length ? rows.map(asset => <option key={asset.id} value={asset.id}>{asset.name || "未命名"}</option>) : <option value="">暂无{kinds[kind]}</option>}
            </select>
            <button type="button" className="shrink-0 rounded-md border px-2" style={control} onClick={() => {
                const id = `${kind}_${crypto.randomUUID()}`;
                onChange([...assets, {id, kind, name:"", description:"", sourceRefs:[],
                    ...(kind === "character" ? {variants:[{id:`outfit_${crypto.randomUUID()}`,name:"默认造型",description:""}]} : {})}]);
                setActiveId(id);
            }}>添加</button>
        </div>
        {active && <>
            <button type="button" className="rounded-md border px-2 py-1" style={control}
                aria-label={`删除${kinds[kind]}${active.name ? `：${active.name}` : ""}`}
                onClick={() => {
                    onChange(assets.filter(asset => asset !== active));
                    setActiveId("");
                }}>从草案删除{kinds[kind]}</button>
            <label className="block">名称
                <input className={fieldClass} style={control} value={active.name} maxLength={240}
                    onChange={event => edit({name:event.target.value})} />
            </label>
            <label className="block">描述
                <textarea className={fieldClass} style={control} value={active.description} rows={3} maxLength={20000}
                    onChange={event => edit({description:event.target.value})} />
            </label>
            {active.sourceRefs.length > 0 && <p className="break-words opacity-70">原文出处 {active.sourceRefs.join("、")}</p>}
            {kind !== "prop" && <details key={active.id} className="space-y-2">
                <summary className="cursor-pointer">{kind === "character" ? "造型" : "场景变体"} · {variants.length}</summary>
                {variants.map((variant, index) => <div key={variant.id} className="space-y-1">
                    <input aria-label={`变体 ${index + 1} 名称`} className={fieldClass} style={control} maxLength={240} value={variant.name}
                        onChange={event => edit({variants:variants.map(item => item === variant ? {...item, name:event.target.value} : item)})} />
                    <textarea aria-label={`变体 ${index + 1} 描述`} className={fieldClass} style={control} maxLength={20000} value={variant.description}
                        onChange={event => edit({variants:variants.map(item => item === variant ? {...item, description:event.target.value} : item)})} />
                </div>)}
                <button type="button" disabled={variants.length >= 32} className="rounded-md border px-2 py-1" style={control}
                    onClick={() => edit({variants:[...variants, {id:`variant_${crypto.randomUUID()}`,name:"",description:""}]})}>添加{kind === "character" ? "造型" : "变体"}</button>
            </details>}
        </>}
    </fieldset>;
}
