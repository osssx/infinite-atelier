import {useCallback,useEffect,useMemo,useState} from "react";
import {App,Button,Input,Modal,Popover,Popconfirm,Select,Switch,Tag,Tooltip,Typography} from "antd";
import {CopyPlus,FileJson,History,Image as ImageIcon,Music2,Pencil,Plus,RefreshCw,SlidersHorizontal,Trash2,Video} from "lucide-react";
import {useConfigStore} from "@/stores/use-config-store";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {ComfyWorkflowPanel} from "./comfy-workflow-panel";
import type {ComfyInstance} from "./run-types";
import {deleteSqliteComfyInstance,listSqliteComfyInstances,saveSqliteComfyInstance} from "./sqlite-instances-client";
import {listComfyWorkflowVersions,saveComfyPresetBinding,type ComfyPreset} from "./preset-registry";
import {listComfyPresetCatalog,type ComfyCatalogPreset} from "./preset-catalog";
import {deleteComfyPreset} from "./preset-registry";
import {getComfyTemplate} from "./template-registry";
import {createComfyTemplate} from "./template-schema";

const localDefault="http://127.0.0.1:8188";
function makeTemplateNode(preset?:ComfyPreset,id=preset?.id??crypto.randomUUID()):CanvasNodeData {
    return {id,type:"comfy:workflow",title:"预设工作流",position:{x:0,y:0},width:400,height:300,
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
    const [presetActionBusy,setPresetActionBusy]=useState<string|null>(null);
    const [editor,setEditor]=useState<{key:string;node:CanvasNodeData;name:string}|null>(null);
    const [presetSearch,setPresetSearch]=useState("");
    const [presetSource,setPresetSource]=useState("all");
    const [presetKind,setPresetKind]=useState("all");
    const [presetMediaType,setPresetMediaType]=useState("all");
    const [presetStatus,setPresetStatus]=useState("all");
    const [expandedGroups,setExpandedGroups]=useState<Set<string>>(new Set());
    const [jsonPreset,setJsonPreset]=useState<{name:string;json:string}|null>(null);
    const [workflowVersions,setWorkflowVersions]=useState<Record<string,{revision:string;templateId:string;workflowHash:string;createdAt:number}[]>>({});

    const reloadInstances=useCallback(async()=>{
        setLoading(true);setInstanceError("");
        try {setInstances(await listSqliteComfyInstances());}
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
    const filteredPresets=useMemo(()=>presets.filter(p=>
        (presetSource==="all"||p.source===presetSource)&&(presetKind==="all"||(p.kind??"base")===presetKind)&&
        (presetMediaType==="all"||p.mediaType===presetMediaType)&&(presetStatus==="all"||p.status===presetStatus)&&
        (!presetSearch||[p.name,p.id,p.templateId,p.revision].some(v=>v.toLowerCase().includes(presetSearch.toLowerCase())))),
        [presets,presetSearch,presetSource,presetKind,presetMediaType,presetStatus]);
    const presetGroups=useMemo(()=>{
        const groups=new Map<string,ComfyCatalogPreset[]>();
        for(const preset of filteredPresets){const key=preset.workflowId??preset.templateId;groups.set(key,[...(groups.get(key)??[]),preset]);}
        return [...groups.entries()];
    },[filteredPresets]);

    const saveInstance=async()=>{
        if(!editingInstance)return;
        setBusy(true);
        try{
            const next=await saveSqliteComfyInstance(editingInstance.id.trim(),editingInstance.url.trim(),editingInstance.originalId);
            if(config.comfyInstanceId===editingInstance.originalId)update("comfyInstanceId",next.instance.id);
            setEditingInstance(null);message.success("ComfyUI 实例已保存");
            await reloadInstances();
        }catch(error){message.error(error instanceof Error?error.message:String(error));}
        finally{setBusy(false);}
    };
    const removeInstance=async(id:string)=>{
        try {await deleteSqliteComfyInstance(id);
            if(config.comfyInstanceId===id)update("comfyInstanceId","");
            message.success("已删除实例");await reloadInstances();
        }catch(error){message.error(error instanceof Error?error.message:String(error));}
    };
    const openPreset=async(preset?:ComfyCatalogPreset)=>{
        const key=preset?.id??crypto.randomUUID(),name=preset?.name??"新预设";
        setEditor({key,name,node:{...makeTemplateNode(preset,key),title:name}});
    };
    const bindPreset=(patch:Partial<CanvasNodeMetadata>):boolean=>{
        const binding=patch.comfyWorkflow;
        if(!binding||!editor)return false;
        setEditor(current=>current?{...current,node:{...current.node,metadata:{...current.node.metadata,...patch}}}:current);
        return true;
    };
    const removePreset=async(preset:ComfyCatalogPreset)=>{
        try{await deleteComfyPreset(preset.id);message.success("已移除预设（不影响现有画布节点）");await reloadPresets();}
        catch(error){message.error(String(error));}
    };
    const createVariant=async(preset:ComfyCatalogPreset)=>{
        setPresetActionBusy(preset.id);
        try{
            let template=await getComfyTemplate(preset.templateId,preset.revision);
            if(!template)throw Error("工作流版本不存在");
            const id=`${preset.id}:variant:${crypto.randomUUID().slice(0,8)}`;
            const variant=await createComfyTemplate(id,{name:`${preset.name} 变体`,apiGraph:template.apiGraph,
                ports:template.ports,requirements:template.requirements,
                ...(template.previewBinding?{previewBinding:template.previewBinding}:{}),
                ...(template.mediaUseCase?{mediaUseCase:template.mediaUseCase}:{})});
            await saveComfyPresetBinding({id,name:variant.name,workflowId:preset.workflowId??preset.templateId,
                templateId:variant.id,revision:variant.revision,source:"user",kind:"variant",parentId:preset.id},variant);
            await reloadPresets();setExpandedGroups(groups=>new Set(groups).add(preset.workflowId??preset.templateId));
            message.success("已创建独立绑定快照；graph 文件与基础工作流去重共享");
        }catch(error){message.error("创建变体失败："+(error instanceof Error?error.message:String(error)));}
        finally{setPresetActionBusy(null);}
    };
    const showPresetJson=async(preset:ComfyCatalogPreset)=>{
        try{const template=await getComfyTemplate(preset.templateId,preset.revision);if(!template)throw Error("工作流版本不存在");
            setJsonPreset({name:preset.name,json:JSON.stringify(template.apiGraph,null,2)});}
        catch(error){message.error(String(error));}
    };
    const switchPresetVersion=async(preset:ComfyCatalogPreset,revision:string)=>{
        try{const target=workflowVersions[preset.id]?.find(version=>version.revision===revision);
            if(!target)throw Error("工作流版本不存在");
            const [current,source]=await Promise.all([getComfyTemplate(preset.templateId,preset.revision),getComfyTemplate(target.templateId??preset.templateId,revision)]);
            if(!current||!source)throw Error("工作流版本不存在");
            const rebound=await createComfyTemplate(preset.templateId,{...current,apiGraph:source.apiGraph});
            await saveComfyPresetBinding({id:preset.id,name:preset.name,workflowId:preset.workflowId??preset.templateId,
                templateId:rebound.id,revision:rebound.revision,source:preset.source??"user",kind:preset.kind??"base",...(preset.parentId?{parentId:preset.parentId}:{})},rebound);
            await reloadPresets();message.success("已使用选定 graph 发布新的绑定快照");}
        catch(error){message.error("切换版本失败："+String(error));}
    };
    const showWorkflowVersions=async(preset:ComfyCatalogPreset)=>{
        try{const versions=await listComfyWorkflowVersions(preset.workflowId??preset.templateId);setWorkflowVersions(current=>({...current,[preset.id]:versions}));
            if(!versions.length)message.info("没有可用版本");}
        catch(error){message.error("读取版本失败："+String(error));}
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
            <p className="mt-2 text-xs text-stone-500">实例配置保存在本地后端，修改后可直接执行，无需重启；实例未连接时请先启动对应 ComfyUI 服务。</p>
        </section>
        <section className="border-t border-stone-200 pt-5 dark:border-stone-800">
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold">预设工作流</h3>
                <Button size="small" icon={<Plus size={13}/>} onClick={()=>void openPreset()}>新增 / 导入工作流</Button>
            </div>
            <div className="mb-3 flex flex-wrap gap-2">
                <Input className="min-w-56 flex-1" allowClear placeholder="搜索工作流名称、ID 或 revision" value={presetSearch} onChange={event=>setPresetSearch(event.target.value)}/>
                <Select aria-label="来源筛选" value={presetSource} onChange={setPresetSource} options={[{value:"all",label:"全部来源"},{value:"user",label:"用户"},{value:"import",label:"导入"}]}/>
                <Select value={presetKind} onChange={setPresetKind} options={[{value:"all",label:"全部类型"},{value:"base",label:"基础"},{value:"variant",label:"变体"}]}/>
                <Select value={presetMediaType} onChange={setPresetMediaType} options={[{value:"all",label:"全部媒体"},{value:"image",label:"图片"},{value:"video",label:"视频"},{value:"audio",label:"音频"},{value:"other",label:"其他"}]}/>
                <Select value={presetStatus} onChange={setPresetStatus} options={[{value:"all",label:"全部状态"},{value:"available",label:"可用"},{value:"missing",label:"缺失 / 加载失败"}]}/>
            </div>
            <div className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                {presetGroups.map(([groupId,group])=>{
                    const preset=group.find(item=>item.kind!=="variant"&&!item.parentId)??group[0];
                    const variants=group.filter(item=>item.id!==preset.id);
                    const expanded=expandedGroups.has(groupId)||Boolean(presetSearch);
                    const rows=expanded||!variants.length?group:[preset];
                    return <div key={groupId} data-comfy-workflow-group={groupId}>
                    {rows.map(item=>{
                        const mediaLabel=item.mediaType==="video"?"视频":item.mediaType==="audio"?"音频":item.mediaType==="image"?"图片":"其他";
                        const MediaIcon=item.mediaType==="video"?Video:item.mediaType==="audio"?Music2:item.mediaType==="image"?ImageIcon:null;
                        const versions=workflowVersions[item.id]??[];
                        return <div className={`flex min-w-0 items-center gap-2 border-t border-stone-200 px-2.5 py-2 dark:border-stone-800 sm:gap-3 sm:px-3 ${item.kind==="variant"?"pl-7 sm:pl-9":""}`} key={item.id} data-comfy-preset={item.id}>
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                {item.id===preset.id&&variants.length?<Tooltip title={expanded?"折叠变体":"展开变体"}><Button type="text" size="small" className="!h-6 !w-6 !shrink-0 !p-0" aria-label={expanded?"折叠变体":"展开变体"} onClick={()=>setExpandedGroups(current=>{const next=new Set(current);expanded?next.delete(groupId):next.add(groupId);return next;})}>{expanded?"−":"+"}</Button></Tooltip>:null}
                                {MediaIcon?<Tooltip title={mediaLabel}><MediaIcon size={15} className="shrink-0 text-stone-500" aria-label={mediaLabel}/></Tooltip>:null}
                                <Tooltip title={item.status==="missing"?"模板版本缺失或不可读取":"模板可用"}><span aria-label={item.status==="missing"?"模板缺失":"模板可用"} className={`size-2 shrink-0 rounded-full ${item.status==="missing"?"bg-red-500":"bg-emerald-500"}`}/></Tooltip>
                                <span className="min-w-0 truncate text-sm font-medium" title={item.name}>{item.name}</span>
                                {item.id===preset.id&&variants.length?<Tooltip title={`${variants.length} 个变体`}><Tag className="!mr-0 !shrink-0">{variants.length}</Tag></Tooltip>:null}
                            </div>
                            <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-stone-500" title={item.revision}>
                                <span className="hidden sm:inline">{item.revision.slice(0,8)}</span>
                                <Popover trigger="click" placement="bottomRight" onOpenChange={open=>{if(open)void showWorkflowVersions(item);}}
                                    content={versions.length?<Select aria-label={`切换 ${item.name} 版本`} size="small" className="w-44" value={item.revision}
                                        options={versions.map(version=>({value:version.revision,label:`${version.revision.slice(0,10)} · ${version.templateId}`}))}
                                        onChange={revision=>void switchPresetVersion(item,revision)}/>:<span className="text-xs text-stone-500">暂无可用版本</span>}>
                                    <Tooltip title="版本历史"><Button type="text" size="small" aria-label={`版本历史 ${item.name}`} icon={<History size={14}/>} className="!h-7 !w-7 !p-0"/></Tooltip>
                                </Popover>
                            </span>
                            <span className="flex shrink-0 items-center gap-0.5">
                                <Tooltip title="编辑绑定"><Button type="text" size="small" aria-label={`编辑绑定 ${item.name}`} loading={presetActionBusy===item.id} icon={<SlidersHorizontal size={15}/>} className="!h-7 !w-7 !p-0" onClick={()=>void openPreset(item)}/></Tooltip>
                                <Tooltip title="查看 JSON"><Button type="text" size="small" aria-label={`查看 JSON ${item.name}`} icon={<FileJson size={15}/>} className="!h-7 !w-7 !p-0" onClick={()=>void showPresetJson(item)}/></Tooltip>
                                {item.id===preset.id?<Tooltip title="创建变体"><Button type="text" size="small" aria-label={`创建 ${item.name} 的变体`} disabled={presetActionBusy!==null} icon={<CopyPlus size={15}/>} className="!h-7 !w-7 !p-0" onClick={()=>void createVariant(preset)}/></Tooltip>:null}
                                <Popconfirm title={`移除“${item.name}”预设？`} onConfirm={()=>void removePreset(item)}><Tooltip title="删除预设"><Button danger type="text" size="small" aria-label={`删除预设 ${item.name}`} icon={<Trash2 size={15}/>} className="!h-7 !w-7 !p-0"/></Tooltip></Popconfirm>
                            </span>
                        </div>;
                    })}
                    </div>;
                })}
                {!filteredPresets.length?<p className="px-3 py-5 text-sm text-stone-500">{presetsBusy?"正在加载…":presets.length?"没有匹配的工作流，请调整搜索或筛选条件。":"还没有工作流。使用“新增 / 导入工作流”导入 ComfyUI API JSON。"}</p>:null}
            </div>
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
        <Modal title={jsonPreset?.name?`${jsonPreset.name} · JSON`:"工作流 JSON"} open={!!jsonPreset} footer={null} onCancel={()=>setJsonPreset(null)} width="min(900px, calc(100vw - 32px))">
            <pre className="max-h-[70vh] overflow-auto rounded bg-stone-950 p-4 text-xs text-stone-100">{jsonPreset?.json}</pre>
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
