import { useState } from "react";
import { Button } from "antd";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import {applyDramaProduction,type DramaVideoInput,type DramaShotProduction} from "./drama-pipeline-media";
import { dramaNodeControl, dramaNodePrimary } from "./drama-node-style";
import {useEffectiveConfig} from "@/stores/use-config-store";
import {prepareDramaProduction} from "./drama-media-preflight";

export function DramaVideoConfigFields({
    inputs, episodes, configs, missingCount, missingFor, hasUnconfirmedChanges, disabled, theme, onCreateSelected, onAction,
    productionStyle,production={},onProductionChange,onPickImage,onRefresh,
}: {
    inputs: DramaVideoInput[];
    episodes: {id: string; title: string}[];
    configs?: ReadonlyMap<string, CanvasNodeData>;
    missingCount: number;
    missingFor: (input: DramaVideoInput) => string[];
    hasUnconfirmedChanges: boolean;
    disabled: boolean;
    theme: CanvasTheme;
    onCreateSelected: (inputs:DramaVideoInput[]) => void;
    onAction: (input: DramaVideoInput, existing?: CanvasNodeData) => void;
    productionStyle?:string;
    production?:Record<string,DramaShotProduction>;
    onProductionChange?:(shotId:string,value:DramaShotProduction)=>void;
    onPickImage?:(onPick:(storageKey:string)=>void)=>void;
    onRefresh?:(id:string,input:DramaVideoInput,fields:{prompt:boolean;duration:boolean;references?:boolean;overwrite:boolean})=>void;
}) {
    const [episodeId, setEpisodeId] = useState("");
    const [shotId, setShotId] = useState("");
    const [selected, setSelected] = useState<string[]>([]);
    const [error,setError]=useState("");
    const [refreshPrompt,setRefreshPrompt]=useState(true);
    const [refreshReferences,setRefreshReferences]=useState(false);
    const [refreshDuration,setRefreshDuration]=useState(false);
    const [overwrite,setOverwrite]=useState(false);
    const config=useEffectiveConfig();
    const episodeIds = [...new Set(inputs.map(({shot}) => shot.episodeId))];
    const activeEpisode = episodeIds.includes(episodeId) ? episodeId : episodeIds[0];
    const episodeInputs = inputs.filter(({shot}) => shot.episodeId === activeEpisode)
        .sort((a, b) => a.shot.order - b.shot.order);
    const active = episodeInputs.find(({shot}) => shot.id === shotId) ?? episodeInputs[0];
    const control = dramaNodeControl(theme);
    const muted = {color:theme.node.muted};
    if (!active) return <p className="rounded-xl border border-dashed px-3 py-4" style={control}>
        确认分镜后可创建视频配置。
    </p>;

    const existing = configs?.get(active.shot.id);
    const setting=production[active.shot.id]??{mode:active.referenceImages.length?"omni_reference":"text_to_video"};
    let preview=active;
    let previewError="";
    try{preview=applyDramaProduction(active,setting);}catch(error){previewError=error instanceof Error?error.message:"输入配置无效";}
    const selectedInputs = inputs.filter(input=>selected.includes(input.shot.id)&&!configs?.has(input.shot.id));
    const source = existing?.metadata?.dramaVideoSource;
    const referenceKeys = preview.referenceImages.flatMap(reference=>reference.storageKey?[reference.storageKey]:[]);
    const outdated = source && (source.visualStyle!==productionStyle||(source.promptShot??source.shot)!==JSON.stringify(active.shot)||
        JSON.stringify(source.referenceKeys)!==JSON.stringify(referenceKeys));
    const missing = missingFor(active);
    const field = "w-full min-w-0 rounded-lg border px-3 py-1.5 leading-relaxed";
    return <section aria-label="镜头视频配置" className="grid min-w-0 gap-3">
        <div className="grid grid-cols-2 gap-2">
            <label className="grid min-w-0 gap-1">剧集
                <select className={field} style={control} value={activeEpisode} onChange={event => setEpisodeId(event.target.value)}>
                    {episodeIds.map(id => <option key={id} value={id}>{episodes.find(episode => episode.id === id)?.title || id}</option>)}
                </select>
            </label>
            <label className="grid min-w-0 gap-1">镜头
                <select className={field} style={control} value={active.shot.id} onChange={event => setShotId(event.target.value)}>
                    {episodeInputs.map(({shot}, index) => <option key={shot.id} value={shot.id}>
                        镜头 {index + 1} · {shot.shotSize || shot.id}
                    </option>)}
                </select>
            </label>
        </div>
        <div className="grid min-w-0 gap-2 rounded-xl border p-3" style={control}>
            <span className="font-medium">画面描述</span>
            <p className="line-clamp-3 break-words whitespace-pre-wrap">{active.shot.description}</p>
            <label className="grid gap-1">视频输入模式
                <select className={field} style={control} disabled={disabled} value={setting.gridInput?"grid":setting.mode}
                    onChange={event=>onProductionChange?.(active.shot.id,{...setting,
                        gridInput:event.target.value==="grid",mode:event.target.value==="grid"?"omni_reference":event.target.value as DramaShotProduction["mode"]})}>
                    <option value="text_to_video">纯文本</option><option value="omni_reference">资产参考图</option>
                    <option value="first_frame">首帧</option><option value="first_last_frame">首尾帧</option>
                    <option value="grid">分镜网格参考图</option>
                </select>
            </label>
            {setting.gridInput&&<Button disabled={disabled||!onPickImage} onClick={()=>onPickImage?.(key=>
                onProductionChange?.(active.shot.id,{...setting,gridImage:key}))}>{setting.gridImage?"更换分镜网格图":"选择分镜网格图"}</Button>}
            {(setting.mode==="first_frame"||setting.mode==="first_last_frame")&&
                <div className="flex flex-wrap gap-2">
                    <Button disabled={disabled||!onPickImage} onClick={()=>onPickImage?.(key=>
                        onProductionChange?.(active.shot.id,{...setting,firstFrame:key}))}>{setting.firstFrame?"更换首帧":"选择首帧"}</Button>
                    {setting.mode==="first_last_frame"&&<Button disabled={disabled||!onPickImage} onClick={()=>onPickImage?.(key=>
                        onProductionChange?.(active.shot.id,{...setting,lastFrame:key}))}>{setting.lastFrame?"更换尾帧":"选择尾帧"}</Button>}
                </div>}
            {existing && !source && <p style={muted}>旧配置来源待核对。</p>}
            {outdated && <p role="status">分镜或参考图已有更新，现有配置仍保留原设置。</p>}
            {existing&&source?.basePrompt&&onRefresh&&<details key={existing.id}>
                <summary>选择采用的分镜更新</summary>
                <label className="block"><input type="checkbox" checked={refreshPrompt}
                    disabled={refreshReferences} onChange={event=>setRefreshPrompt(event.target.checked)}/> 镜头提示词</label>
                <label className="block"><input type="checkbox" checked={refreshDuration}
                    onChange={event=>setRefreshDuration(event.target.checked)}/> 镜头时长</label>
                <label className="block"><input type="checkbox" checked={refreshReferences}
                    onChange={event=>{setRefreshReferences(event.target.checked);if(event.target.checked)setRefreshPrompt(true);}}/> 参考图和输入模式</label>
                <label className="block"><input type="checkbox" checked={overwrite}
                    onChange={event=>setOverwrite(event.target.checked)}/> 覆盖所选字段中的人工修改</label>
                <pre className="whitespace-pre-wrap">{active.prompt}</pre>
                <Button disabled={disabled||(!refreshPrompt&&!refreshDuration)} onClick={async()=>{
                    try{
                        if(previewError)throw Error(previewError);
                        const selectedWorkflow=existing.metadata?.comfyWorkflowSelections?.video;
                        const prepared=refreshReferences?await prepareDramaProduction(preview,{...config,
                            videoModel:existing.metadata?.model||config.videoModel,
                            comfyWorkflowDefaults:{...config.comfyWorkflowDefaults,video:selectedWorkflow}}):preview;
                        onRefresh(existing.id,prepared,{prompt:refreshPrompt,duration:refreshDuration,references:refreshReferences,overwrite});
                        setError("");
                        setOverwrite(false);
                    }catch(error){setError(error instanceof Error?error.message:"更新失败");}
                }}>采用所选更新</Button>
            </details>}
            <details>
                <summary>查看镜头提示词与参考图</summary>
                <pre className="whitespace-pre-wrap break-words">{preview.prompt}</pre>
                {preview.referenceImages.map(reference=><span key={reference.id} className="mr-2">{reference.name}</span>)}
                {previewError&&<p role="alert">{previewError}</p>}
                {outdated && <details><summary>配置创建时的提示词</summary>
                    <pre className="whitespace-pre-wrap break-words">{source.prompt}</pre>
                </details>}
            </details>
            {setting.mode==="omni_reference"&&!setting.gridInput&&missing.length > 0 && <p className="break-words text-xs" style={muted}>缺少主图：{missing.join("、")}</p>}
            <div className="flex justify-end">
                <Button size="small" disabled={disabled} style={disabled ? control : dramaNodePrimary(theme)}
                    onClick={async () => {
                        try{
                            setError("");
                            const input=existing?active:await prepareDramaProduction(applyDramaProduction(active,setting),config);
                            onAction(input,existing);
                        }
                        catch(error){setError(error instanceof Error?error.message:"输入配置无效");}
                    }}>{existing ? "打开配置" : "创建视频配置"}</Button>
            </div>
        </div>
        {hasUnconfirmedChanges && <p className="text-xs" style={muted}>当前使用最近一次确认的分镜。</p>}
        <details>
            <summary>选择批量配置的镜头</summary>
            <div className="grid gap-1">
                {episodeInputs.filter(input=>!configs?.has(input.shot.id)).map(input=>
                    <label key={input.shot.id}>
                        <input type="checkbox" checked={selected.includes(input.shot.id)} onChange={event=>{
                            const checked=event.target.checked;
                            setSelected(current=>checked?[...current,input.shot.id]:current.filter(id=>id!==input.shot.id));
                        }}/> 镜头 {input.shot.order} · {input.shot.description}
                    </label>)}
            </div>
        </details>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs" style={muted}>已配置 {inputs.length - missingCount} / {inputs.length}</span>
            <Button size="small" style={control} disabled={!selectedInputs.length || disabled} onClick={async()=>{
                try{
                    setError("");
                    const prepared=await Promise.all(selectedInputs.map(input=>prepareDramaProduction(applyDramaProduction(input,production[input.shot.id]),config)));
                    onCreateSelected(prepared);
                    setSelected([]);
                }catch(error){setError(error instanceof Error?error.message:"输入配置无效");}
            }}>创建所选视频配置（{selectedInputs.length}）</Button>
        </div>
        {error&&<p role="alert">{error}</p>}
    </section>;
}
