import {useCallback,useEffect,useMemo,useState} from "react";
import {App,Button,Input,Modal,Popconfirm,Select,Switch,Tag,Typography} from "antd";
import {Pencil,Plus,RefreshCw,Trash2} from "lucide-react";
import {useConfigStore} from "@/stores/use-config-store";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {ComfyWorkflowPanel} from "./comfy-workflow-panel";
import {deleteComfyInstance,listComfyInstances,saveComfyInstance,type ComfyInstance} from "./run-client";
import {saveComfyPreset,type ComfyPreset} from "./preset-registry";
import {installBundledComfyTemplate,listComfyPresetCatalog,resetBundledComfyPreset,type ComfyCatalogPreset} from "./preset-catalog";
import {MINIMAX_H3_I2V_TEMPLATE_ID} from "./minimax-h3-i2v-preset";
import {deleteComfyPreset} from "./preset-registry";
import {getComfyTemplate} from "./template-registry";
import {readLegacyComfySnapshot,importLegacyComfySnapshot} from "./legacy-comfy-import";

const localDefault="http://127.0.0.1:8188";
function makeTemplateNode(preset?:ComfyPreset):CanvasNodeData {
    return {id:"comfy-global-preset-editor",type:"comfy:workflow",title:"预设工作流",position:{x:0,y:0},width:400,height:300,
        metadata:preset?{comfyWorkflow:{templateId:preset.templateId,templateRevision:preset.revision,
            bindingState:"bound",inputOverrides:{}}}:{}};
}

export function ComfySettingsTab() {
    const {message}=App.useApp();
    const config=useConfigStore(state=>state.config);
    const update=useConfigStore(state=>state.updateConfig);
    const [instances,setInstances]=useState<ComfyInstance[]>([]);
    const [instanceError,setInstanceError]=useState("");
    const [loading,setLoading]=useState(false);
    const [editingInstance,setEditingInstance]=useState<{originalId?:string;id:string;url:string}|null>(null);
    const [busy,setBusy]=useState(false);
    const [presets,setPresets]=useState<ComfyCatalogPreset[]>([]);
    const [presetsBusy,setPresetsBusy]=useState(false);
    const [importBusy,setImportBusy]=useState(false);
    const [presetActionBusy,setPresetActionBusy]=useState<string|null>(null);
    const [editor,setEditor]=useState<{key:string;node:CanvasNodeData;name:string}|null>(null);

    const reloadInstances=useCallback(async()=>{
        setLoading(true);setInstanceError("");
        try {setInstances(await listComfyInstances());}
        catch(error){setInstances([]);setInstanceError(error instanceof Error?error.message:String(error));}
        finally {setLoading(false);}
    },[]);
    const reloadPresets=useCallback(async()=>{
        setPresetsBusy(true);
        try {setPresets(await listComfyPresetCatalog());}
        catch(error){message.error(error instanceof Error?error.message:String(error));}
        finally{setPresetsBusy(false);}
    },[message]);
    useEffect(()=>{if(config.comfyAutoDetect!==false)void reloadInstances();void reloadPresets();},[reloadInstances,reloadPresets]);
    const selected=instances.find(x=>x.id===config.comfyInstanceId);
    const selectedOptions=useMemo(()=>instances.map(x=>({label:x.id+(x.reachable?"":"（离线）"),value:x.id})),[instances]);

    const saveInstance=async()=>{
        if(!editingInstance)return;
        setBusy(true);
        try{
            const next=await saveComfyInstance(editingInstance.id.trim(),editingInstance.url.trim(),editingInstance.originalId);
            if(config.comfyInstanceId===editingInstance.originalId)update("comfyInstanceId",next.instance.id);
            setEditingInstance(null);message.success("ComfyUI 实例已保存");
            await reloadInstances();
        }catch(error){message.error(error instanceof Error?error.message:String(error));}
        finally{setBusy(false);}
    };
    const removeInstance=async(id:string)=>{
        try {await deleteComfyInstance(id);
            if(config.comfyInstanceId===id)update("comfyInstanceId","");
            message.success("已删除实例");await reloadInstances();
        }catch(error){message.error(error instanceof Error?error.message:String(error));}
    };
    const openPreset=async(preset?:ComfyCatalogPreset)=>{
        if(preset?.builtIn) {
            setPresetActionBusy(preset.id);
            try {
                // Bundled defaults are visible before any backend template installation.
                // Materialize their immutable template only when the user edits.
                await installBundledComfyTemplate(preset.builtinId!);
            }catch(error){message.error("加载内置预设失败："+String(error));return;}
            finally{setPresetActionBusy(null);}
        }
        setEditor({key:preset?.id??crypto.randomUUID(),name:preset?.name??"新预设",
            node:makeTemplateNode(preset)});
    };
    const resetBuiltin=async(preset:ComfyCatalogPreset)=>{
        setPresetActionBusy(preset.id);
        try{
            await resetBundledComfyPreset(preset.builtinId!);
            await reloadPresets();
            message.success("已重置为内置默认工作流与端口绑定；已绑定的画布节点不受影响");
        }catch(error){message.error("重置内置预设失败："+String(error));}
        finally{setPresetActionBusy(null);}
    };
    const bindPreset=(patch:Partial<CanvasNodeMetadata>):boolean=>{
        const binding=patch.comfyWorkflow;
        if(!binding||!editor)return false;
        const id=editor.key;
        setEditor(current=>current?{...current,node:{...current.node,metadata:{...current.node.metadata,...patch}}}:current);
        void getComfyTemplate(binding.templateId,binding.templateRevision).then(template=>{
            if(!template)throw Error("找不到新保存的模板版本");
            return saveComfyPreset({id,name:template.name,templateId:template.id,revision:template.revision});
        }).then(()=>{
            message.success("已保存预设及输入/输出端口绑定");
            return reloadPresets();
        }).catch(error=>message.error("预设保存失败："+String(error)));
        return true;
    };
    const removePreset=async(preset:ComfyCatalogPreset)=>{
        try{if(preset.builtIn)throw Error("内置预设不可删除，可使用重置默认");
            await deleteComfyPreset(preset.id);message.success("已移除预设（不影响现有画布节点）");await reloadPresets();}
        catch(error){message.error(String(error));}
    };
    const importLegacy=async()=>{
        setImportBusy(true);
        try{
            const snapshot=await readLegacyComfySnapshot();
            if(!snapshot.templates.length&&!snapshot.presets.length){
                message.info("当前浏览器没有可导入的旧模板或预设");return;
            }
            Modal.confirm({
                title:"从当前浏览器导入旧 ComfyUI 工作流？",
                content:"发现 "+snapshot.templates.length+" 个历史模板版本、"+
                    snapshot.presets.length+" 个预设。将复制到后端 SQLite；原浏览器数据不会删除。已有同 ID 的不同预设会拒绝覆盖。",
                okText:"确认导入",cancelText:"取消",
                onOk:async()=>{
                    try{
                        const result=await importLegacyComfySnapshot(snapshot);
                        message.success("已导入 "+result.templates+" 个模板版本、"+result.presets+" 个预设");
                        await reloadPresets();
                    }catch(error){message.error("导入历史预设失败："+String(error));throw error;}
                }
            });
        }catch(error){message.error("读取历史工作流失败："+String(error))}
        finally{setImportBusy(false)}
    };
    return <div className="space-y-6 pb-5" data-comfy-settings-tab>
        <section>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold">ComfyUI 本地实例配置</h3>
                <div className="flex gap-2">
                    <Button size="small" icon={<RefreshCw size={13}/>} loading={loading} onClick={()=>void reloadInstances()}>测试连接</Button>
                    <Button size="small" icon={<Plus size={13}/>} onClick={()=>setEditingInstance({id:"",url:localDefault})}>新增实例</Button>
                </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                <div className="grid grid-cols-[minmax(90px,1fr)_minmax(140px,2fr)_88px_94px] gap-3 bg-stone-50 px-3 py-2 text-xs text-stone-500 dark:bg-stone-900">
                    <span>实例名称</span><span>服务地址</span><span>连接状态</span><span>操作</span>
                </div>
                {instances.map(inst=><div key={inst.id} className="grid grid-cols-[minmax(90px,1fr)_minmax(140px,2fr)_88px_94px] items-center gap-3 border-t border-stone-200 px-3 py-2 text-xs dark:border-stone-800">
                    <span className="truncate font-medium" title={inst.id}>{inst.id}</span>
                    <span className="truncate text-stone-500" title={inst.url}>{inst.url}</span>
                    <Tag color={inst.reachable?"success":"default"} className="!mr-0">{inst.reachable?"已连接":"未连接"}</Tag>
                    <span className="flex items-center gap-1">
                        <Button type="text" size="small" aria-label={"编辑 "+inst.id} icon={<Pencil size={14}/>} onClick={()=>setEditingInstance({originalId:inst.id,id:inst.id,url:inst.url})}/>
                        <Popconfirm title={"删除 "+inst.id+"？"} onConfirm={()=>void removeInstance(inst.id)}><Button type="text" size="small" aria-label={"删除 "+inst.id} icon={<Trash2 size={14}/>} danger/></Popconfirm>
                    </span>
                </div>)}
                {!instances.length?<p className="px-3 py-4 text-xs text-stone-500">{instanceError||"暂无实例，点击新增实例"}</p>:null}
            </div>
            {instanceError&&instances.length?<p role="alert" className="mt-2 text-xs text-red-500">{instanceError}</p>:null}
        </section>
        <section className="border-t border-stone-200 pt-5 dark:border-stone-800">
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold">预设工作流</h3>
                <div className="flex gap-2"><Button size="small" loading={importBusy} onClick={()=>void importLegacy()}>导入浏览器旧预设</Button><Button size="small" icon={<Plus size={13}/>} onClick={()=>void openPreset()}>新增 / 导入工作流</Button></div>
            </div>
            <div className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                <div className="grid grid-cols-[minmax(130px,1fr)_minmax(120px,2fr)_180px] gap-3 bg-stone-50 px-3 py-2 text-xs text-stone-500 dark:bg-stone-900"><span>名称</span><span>模板 revision</span><span>绑定编辑</span></div>
                {presets.map(preset=><div className="grid grid-cols-[minmax(130px,1fr)_minmax(120px,2fr)_180px] items-center gap-3 border-t border-stone-200 px-3 py-2 text-xs dark:border-stone-800" key={preset.id} data-comfy-preset={preset.id}>
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium" title={preset.name}>{preset.name}</span>
                        {preset.builtIn?<Tag className="!mr-0">内置</Tag>:null}
                        {preset.builtinId===MINIMAX_H3_I2V_TEMPLATE_ID?<Tag className="!mr-0">视频 · 暂不支持画布执行</Tag>:null}
                        {preset.modified?<Tag color="orange" className="!mr-0">已修改</Tag>:null}
                    </span>
                    <span className="truncate font-mono text-stone-500" title={preset.templateId+"@"+preset.revision}>{preset.templateId} · {preset.revision.slice(0,12)}</span>
                    <span className="flex items-center gap-1">
                        <Button type="link" size="small" className="!px-0" loading={presetActionBusy===preset.id}
                            onClick={()=>void openPreset(preset)}>编辑绑定</Button>
                        {preset.builtIn
                            ? preset.modified?<Button size="small" type="link" className="!px-0" disabled={presetActionBusy!==null}
                                onClick={()=>void resetBuiltin(preset)}>重置默认</Button>:null
                            : <Popconfirm title="移除该预设？" onConfirm={()=>void removePreset(preset)}>
                                <Button danger size="small" type="text" aria-label={"移除预设 "+preset.name} icon={<Trash2 size={13}/>} />
                              </Popconfirm>}
                    </span>
                </div>)}
                {!presets.length?<p className="px-3 py-4 text-xs text-stone-500">{presetsBusy?"正在加载…":"尚无预设。可导入 ComfyUI API JSON，编辑输入/输出端口并保存。"}</p>:null}
            </div>
            <p className="mt-2 text-xs text-stone-500">编辑预设时可绑定内部 ComfyUI 输入参数与 IMAGE 输出；保存生成新的不可变模板版本，已有画布节点保留原版本。</p>
        </section>
        <section className="border-t border-stone-200 pt-5 dark:border-stone-800">
            <h3 className="mb-3 text-base font-semibold">默认行为</h3>
            <div className="grid gap-4 md:grid-cols-[minmax(170px,1fr)_minmax(170px,1fr)_auto] md:items-end">
                <label className="grid gap-2 text-xs">默认实例
                    <Select value={config.comfyInstanceId||undefined} placeholder="选择实例" options={selectedOptions} onChange={id=>update("comfyInstanceId",id)} allowClear onClear={()=>update("comfyInstanceId","")}/>
                </label>
                <label className="grid gap-2 text-xs">默认图片输出
                    <Input value="自动采用模板绑定的 IMAGE 输出" disabled/>
                </label>
                <label className="flex items-center gap-2 pb-2 text-xs">
                    <Switch size="small" checked={config.comfyAutoDetect!==false} onChange={value=>update("comfyAutoDetect",value)}/>启动时检测实例
                </label>
            </div>
            {selected&&!selected.reachable?<Typography.Text type="warning" className="!mt-2 !block !text-xs">当前默认实例离线，请检查后端服务。</Typography.Text>:null}
        </section>
        <Modal title={editingInstance?.originalId?"编辑 ComfyUI 实例":"新增 ComfyUI 实例"} open={!!editingInstance} okText="保存" okButtonProps={{loading:busy}} onOk={()=>void saveInstance()} onCancel={()=>setEditingInstance(null)}>
            <div className="space-y-3 py-3">
                <label className="block text-xs">实例名称<Input className="mt-1" placeholder="comfy-local" value={editingInstance?.id??""} onChange={e=>setEditingInstance(v=>v?{...v,id:e.target.value}:v)}/></label>
                <label className="block text-xs">本机地址<Input className="mt-1" placeholder={localDefault} value={editingInstance?.url??""} onChange={e=>setEditingInstance(v=>v?{...v,url:e.target.value}:v)}/></label>
                <p className="text-xs text-stone-500">安全限制：仅支持 127.0.0.1 或 [::1] 的 HTTP 完整端口地址。运行中的任务会阻止修改实例。</p>
            </div>
        </Modal>
        <Modal
            className="comfy-preset-editor-modal"
            open={!!editor}
            width="min(1080px, calc(100vw - 32px))"
            centered
            footer={null}
            destroyOnHidden
            title={<div className="min-w-0 pr-6">
                <div className="text-base font-semibold">编辑预设工作流</div>
                <div className="mt-1 text-xs font-normal text-stone-500 dark:text-stone-400">
                    编辑内部节点参数、画布输入端口和 IMAGE 输出绑定
                </div>
            </div>}
            onCancel={()=>{setEditor(null);void reloadPresets();}}
            styles={{body:{padding:0,height:"min(720px, calc(100dvh - 160px))",minHeight:260,overflow:"hidden"}}}
        >
            {editor?<div className="h-full min-h-0 min-w-0 w-full" data-comfy-preset-editor-content>
                <ComfyWorkflowPanel key={editor.key} context="preset" node={editor.node} onChange={bindPreset} onClose={()=>{setEditor(null);void reloadPresets();}} />
            </div>:null}
        </Modal>
    </div>;
}
