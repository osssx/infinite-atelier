import { useEffect, useState } from "react";
import { Button } from "antd";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import {applyDramaProduction,type DramaVideoInput,type DramaShotProduction} from "./drama-pipeline-media";
import { dramaNodeControl, dramaNodePrimary } from "./drama-node-style";
import {useEffectiveConfig} from "@/stores/use-config-store";
import {prepareDramaProduction} from "./drama-media-preflight";
import {auditDramaProduction,dramaMediaModes,listDramaProductionCapabilities,type DramaProductionAudit,type DramaProductionCapabilities} from "./drama-production-audit";
import {canvasCasUrl} from "@/features/backend-sync/canvas-cas";

export function DramaVideoConfigFields({
    inputs, episodes, configs, missingCount, missingFor, hasUnconfirmedChanges, disabled, theme, onCreateSelected, onAction,
    productionStyle,production={},onProductionChange,onPickImage,onRefresh,confirmedRevisionId,onCreateBatch,
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
    onCreateBatch?:(shotIds:string[])=>Promise<void>;
    onAction: (input: DramaVideoInput, existing?: CanvasNodeData) => void;
    productionStyle?:string;
    confirmedRevisionId?:string;
    production?:Record<string,DramaShotProduction>;
    onProductionChange?:(shotId:string,value:DramaShotProduction)=>void;
    onPickImage?:(onPick:(storageKey:string)=>void)=>void;
    onRefresh?:(id:string,input:DramaVideoInput,fields:{prompt:boolean;duration:boolean;references?:boolean;overwrite:boolean})=>void;
}) {
    const [episodeId, setEpisodeId] = useState("");
    const [shotId, setShotId] = useState("");
    const [selected, setSelected] = useState<string[]>([]);
    const [batchShots,setBatchShots]=useState<string[]>([]);
    const [error,setError]=useState("");
    const [refreshPrompt,setRefreshPrompt]=useState(true);
    const [refreshReferences,setRefreshReferences]=useState(false);
    const [refreshDuration,setRefreshDuration]=useState(false);
    const [overwrite,setOverwrite]=useState(false);
    const [capabilities,setCapabilities]=useState<DramaProductionCapabilities|null>(null);
    const [audit,setAudit]=useState<DramaProductionAudit|null>(null);
    const [auditing,setAuditing]=useState(false);
    const config=useEffectiveConfig();
    const episodeIds = [...new Set(inputs.map(({shot}) => shot.episodeId))];
    const activeEpisode = episodeIds.includes(episodeId) ? episodeId : episodeIds[0];
    const episodeInputs = inputs.filter(({shot}) => shot.episodeId === activeEpisode)
        .sort((a, b) => a.shot.order - b.shot.order);
    const active = episodeInputs.find(({shot}) => shot.id === shotId) ?? episodeInputs[0];
    const control = dramaNodeControl(theme);
    const muted = {color:theme.node.muted};
    const existing = active?configs?.get(active.shot.id):undefined;
    const setting=active?(production[active.shot.id]??{
        mode:active.referenceImages.length?"omni_reference":"text_to_video",
    } as DramaShotProduction):undefined;
    let preview=active;
    let previewError="";
    if(active&&setting)try{preview=applyDramaProduction(active,setting);}
    catch(error){previewError=error instanceof Error?error.message:"输入配置无效";}
    const missing=active?missingFor(active):[];
    const requiredMissing=setting?.mode==="omni_reference"&&!setting.gridInput?missing:[];
    const auditKey=JSON.stringify([preview,setting,requiredMissing,productionStyle,confirmedRevisionId,previewError]);
    useEffect(()=>{
        let current=true;
        setAudit(null);setCapabilities(null);setAuditing(Boolean(preview&&!previewError));
        void listDramaProductionCapabilities(config).then(available=>{
            if(current)setCapabilities(available);
        }).catch(()=>{if(current)setCapabilities(null);});
        if(preview&&setting&&!previewError){
            void auditDramaProduction(preview,config,{setting,missingReferenceIds:requiredMissing,
                visualStyle:productionStyle,sourceRevisionId:confirmedRevisionId}).then(result=>{
                if(current)setAudit(result);
            }).catch(error=>{
                if(current)setError(error instanceof Error?error.message:"媒体输入预检失败");
            }).finally(()=>{if(current)setAuditing(false);});
        }else setAuditing(false);
        return ()=>{current=false;};
    },[auditKey,config]);
    if (!active||!preview||!setting) return <p className="rounded-xl border border-dashed px-3 py-4" style={control}>
        确认分镜后可创建视频配置。
    </p>;
    const selectedInputs = inputs.filter(input=>selected.includes(input.shot.id)&&!configs?.has(input.shot.id));
    const source = existing?.metadata?.dramaVideoSource;
    const referenceKeys = preview.referenceImages.flatMap(reference=>reference.storageKey?[reference.storageKey]:[]);
    const outdated = source && (source.visualStyle!==productionStyle||(source.promptShot??source.shot)!==JSON.stringify(active.shot)||
        JSON.stringify(source.referenceKeys)!==JSON.stringify(referenceKeys));
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
                    {dramaMediaModes.map(choice=>{
                        const availability=capabilities?.modes.find(item=>item.mode===choice.id);
                        return <option key={choice.id} value={choice.id} disabled={availability?!availability.available:false}
                            title={availability?.reason}>{choice.label}{availability&&!availability.available?"（不支持）":""}</option>;
                    })}                </select>
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
            <div className="grid min-w-0 gap-3 rounded-lg border p-2 md:grid-cols-2"
                aria-label="逐镜媒体输入预检">
                <div className="grid min-w-0 content-start gap-2">
                    <strong>确认分镜与绑定素材</strong>
                    <p className="break-words whitespace-pre-wrap">{active.shot.description}</p>
                    <p className="text-xs">镜头 {active.shot.order} · 时长 {audit?.durationSeconds??active.shot.durationSec??(Number(config.videoSeconds)||6)} 秒
                        · 画幅 {audit?.aspectRatio??config.videoRatio} · 角色造型 {active.shot.characterVariantIds.length} 项
                        · 道具 {active.shot.propIds.length} 项</p>
                    <p>引用图片 {preview.referenceImages.length} 张
                        {referenceKeys.length>0?" · 已保存 CAS "+referenceKeys.length+" 张":""}</p>
                    <div className="flex min-w-0 flex-wrap gap-2">
                        {preview.referenceImages.map((reference,index)=><div key={reference.id}
                            className="grid max-w-28 gap-1">
                            {reference.storageKey&&<img loading="lazy" src={canvasCasUrl(reference.storageKey)??""}
                                alt={reference.name} className="size-20 rounded object-cover"/>}
                            <span className="break-words text-xs">{index+1}. {reference.name}</span>
                        </div>)}
                    </div>
                    {!!requiredMissing.length&&<p role="alert">缺少必需参考图：{requiredMissing.join("、")}</p>}
                </div>
                <div className="grid min-w-0 content-start gap-2">
                    <strong>实际提交 Prompt / 能力检查</strong>
                    <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border p-2">{audit?.prompt??preview.prompt}</pre>
                    <p className="text-xs">执行渠道：{capabilities?.channel??"检查中"}
                        · {capabilities?.model??""} · {capabilities?.engine==="comfy"?"ComfyUI 工作流":"在线渠道"}</p>
                    {auditing&&<p role="status">正在核验工作流端口和媒体约束…</p>}
                    {!auditing&&!previewError&&audit?.ready&&<p role="status">输入预检通过，创建配置不会自动生成媒体。</p>}
                    {(previewError||audit&&!audit.ready)&&<p role="alert">
                        {previewError||audit?.error}。请选择可用模式，补齐素材或调整模板参数。
                    </p>}
                    {capabilities&&<p className="text-xs">
                        可用模式：{capabilities.modes.filter(item=>item.available).map(item=>item.label).join("、")||"无"}
                    </p>}
                    {outdated&&source&&<details>
                        <summary>与旧视频配置的差异（不会自动覆盖）</summary>
                        <p>旧时长 {source.seconds??"未知"} 秒 · 旧风格 {source.visualStyle??"未记录"}</p>
                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{source.prompt}</pre>
                    </details>}
                </div>
            </div>            <div className="flex justify-end">
                <Button size="small" disabled={disabled||!existing&&(auditing||!audit?.ready||!!previewError)}
                    style={disabled ? control : dramaNodePrimary(theme)}
                    onClick={async () => {
                        try{
                            setError("");
                            if(existing){onAction(active,existing);return;}
                            if(!audit?.ready||!audit.input||auditing||previewError)
                                throw Error(previewError||audit?.error||"请先通过当前镜头输入预检");
                            onAction(audit.input,existing);
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
                    const audits=await Promise.all(selectedInputs.map(async input=>{
                        const chosen=production[input.shot.id]??{
                            mode:input.referenceImages.length?"omni_reference":"text_to_video",
                        } as DramaShotProduction;
                        const transformed=applyDramaProduction(input,chosen);
                        return {shotId:input.shot.id,audit:await auditDramaProduction(transformed,config,{
                            setting:chosen,visualStyle:productionStyle,sourceRevisionId:confirmedRevisionId,
                            missingReferenceIds:chosen.mode==="omni_reference"&&!chosen.gridInput?missingFor(input):[],
                        })};
                    }));
                    const failures=audits.filter(item=>!item.audit.ready);
                    if(failures.length)throw Error("批量预检不通过："+failures.map(item=>
                        item.shotId+" · "+item.audit.error).join("；"));
                    onCreateSelected(audits.map(item=>item.audit.input!));
                    setSelected([]);
                }catch(error){setError(error instanceof Error?error.message:"输入配置无效");}
            }}>创建所选视频配置（{selectedInputs.length}）</Button>
        </div>
        {onCreateBatch&&<details className="rounded-lg border p-2" aria-label="P3 选镜头组建批量生成">
            <summary>从已配置镜头组建批量生成</summary>
            <p className="text-xs" style={muted}>仅准备本地 ComfyUI 镜头组。默认为独立镜头；
                用户可在镜头组中明确指定前镜成片的尾帧连续性，然后先检查再提交。
                这里不会自动运行模型或生成媒体。</p>
            <div className="grid gap-1">
                {inputs.filter(input=>configs?.has(input.shot.id)).map(input=>
                    <label key={input.shot.id} className="flex items-center gap-2">
                        <input type="checkbox" checked={batchShots.includes(input.shot.id)}
                            disabled={disabled} onChange={event=>setBatchShots(current=>event.target.checked?
                                [...new Set([...current,input.shot.id])]:current.filter(id=>id!==input.shot.id))}/>
                        {episodes.find(item=>item.id===input.shot.episodeId)?.title??input.shot.episodeId} · 镜头 {input.shot.order} · {input.shot.description}                    </label>)}
            </div>
            <Button size="small" disabled={disabled||batchShots.filter(id=>inputs.some(input=>
                input.shot.id===id&&configs?.has(id))).length<2} onClick={async()=>{
                try{
                    setError("");
                    const ids=inputs.filter(input=>batchShots.includes(input.shot.id)&&configs?.has(input.shot.id))
                        .map(input=>input.shot.id);
                    if(ids.length<2)throw Error("至少选择两个已创建视频 Config 的镜头");
                    await onCreateBatch(ids);
                    setBatchShots([]);
                }catch(error){setError(error instanceof Error?error.message:"镜头组创建失败");}
            }}>组建所选镜头并进入批量预检（{batchShots.length}）</Button>
        </details>}
        {error&&<p role="alert">{error}</p>}
    </section>;
}
