import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Modal, Popover, Tag } from "antd";
import { ChevronRight, History, Maximize2, RefreshCw, Sparkles, ShieldAlert, SlidersHorizontal } from "lucide-react";
import type { CanvasNodeData } from "@/types/canvas";
import { DRAMA_PIPELINE_NODE_TYPES, DRAMA_PIPELINE_STAGE_LABELS, readAssetDraft, readStoryboardDraft, type DramaPipelineStage } from "./canvas-drama-pipeline";
import { canvasApi, type CanvasBackendProject } from "@/features/backend-sync/canvas-api";
import {commitAssistantCanvasGraphWithSaveBarrier,ensureCreativeNodesLoaded,useCanvasStore} from "@/stores/canvas/use-canvas-sqlite-store";
import { canvasCasUrl } from "@/features/backend-sync/canvas-cas";
import { CanvasNodeReferenceBar } from "@/components/canvas/canvas-node-reference-bar";
import { ensureSqliteModelChannelForExecution, modelChannelProvider } from "@/features/backend-sync/model-channel-autoroute";
import { buildDramaVideoInput, dramaVideoMissingReferenceIds } from "./drama-pipeline-media";
import { dramaAssetSlots, dramaReferenceImageKeys, referencesForDramaAssets, type DramaAssetReference, type DramaPipelineSnapshot } from "./canvas-drama-pipeline";
import { useEffectiveConfig, resolveModelChannel, modelOptionName } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { DramaAssetFields } from "./drama-asset-fields";
import {DramaAssetWorkspaceFields} from "./drama-asset-workspace-fields";
import type {DramaAssetUsage} from "./drama-asset-usage-display";
import {saveAssetEntry} from "./drama-asset-entry-save";
import type {WorkspacePendingRegistration} from "./drama-creative-workspace";
import {DramaReferenceImagePicker} from "./drama-reference-image-picker";
import {DramaAssetCandidates} from "./drama-asset-candidates";
import {adoptedAssetSelection,DramaCandidateNavigationContext,AssetReviewNavigationContext,useAssetDirectory,type AssetAdoptionMapping} from "./drama-asset-directory-state";
import {DramaCreativeScopeBrowser} from "./drama-creative-scope-browser";
import {DramaStoryboardNavigationContext,DramaStoryboardScopeContext} from "./drama-storyboard-navigation";
const DramaVideoConfigFields = lazy(() => import("./drama-video-config-fields").then(m=>({default:m.DramaVideoConfigFields})));
const DramaBatchConfigPanel = lazy(() => import("./drama-batch-config-panel").then(m=>({default:m.DramaBatchConfigPanel})));
import { DramaStoryboardFields } from "./drama-storyboard-fields";
import { DramaEpisodeFields } from "./drama-episode-fields";
import {DramaEpisodeCandidates} from "./drama-episode-candidates";
import {DramaEpisodeAdoptionReview,type EpisodeAdoptionSelection} from "./drama-episode-adoption-review";
import {candidateRevision,hasEpisodeDetails,mergeCandidateRuns,type DramaRun,type EpisodeCandidateChanges,type WholeEpisodeChanges} from "./drama-episode-candidate-state";
import { readEpisodeDraft } from "../../../server/canvas-text-content.mjs";
import type {DramaBatchCreateResult} from "./drama-video-config";
import {useDramaFeedback,describeDramaFeedbackError,dramaRunStatus,DramaInlineFeedback,type DramaFeedbackLevel} from "./drama-feedback";
import { dramaInlineNodeClass, dramaNodeControl, dramaNodePrimary, DramaNodeStatus } from "./drama-node-style";

const { TextArea } = Input;
type DramaRunChange = {id:string;kind:"added"|"replaced"|"deleted"|"reordered"|"unchanged";
    changed:boolean;reordered:boolean;conflict:boolean;adopted:boolean;
    before?:{order:number;description:string;sequenceId?:string|null}|null;
    after?:{order:number;description:string;sequenceId?:string|null}|null;
    current?:{order:number;description:string}|null};
type DramaSequenceMigration = {projectRevision:number;nodeId:string;episodeId:string;
    episodeDigest:string;rows:{shotId:string;sourceSequenceId:string|null;
        possibleSequenceIds:string[];shotDigest:string;status:string}[]};
type DramaRunPreview = {runId:string;status:string;sourceChanged:boolean;fullAdoptBlocked:boolean;
    items:DramaRunChange[];manualExtraIds:string[];
    summary:{added:number;replaced:number;deleted:number;reordered:number;unchanged:number;conflicts:number}};


export function isDramaPipelineNode(type: string): type is string {
    return Object.values(DRAMA_PIPELINE_NODE_TYPES).includes(type);
}

function readDraft(value: string): Partial<DramaPipelineSnapshot> | null {
    try { return JSON.parse(value); } catch { return null; }
}



function describeDramaValidation(errors: {code:string;shotId?:string;id?:string}[], assets: DramaPipelineSnapshot["assets"]) {
    const sceneIds = assets.filter(asset => asset.kind === "scene").map(asset => `${asset.name}（${asset.id}）`);
    return [...new Set(errors.map(({code, shotId, id}) => {
        const detail = code === "shot_scene_invalid" ? `场景 ID ${id ?? ""} 不在已确认资产中` :
            code === "shot_scene_variant_invalid" ? `场景变体 ${id ?? ""} 不属于所选场景` :
            [code, id].filter(Boolean).join(" ");
        return shotId ? `${shotId}：${detail}` : detail;
    }))].concat(errors.some(error => error.code === "shot_scene_invalid")
        ? [sceneIds.length ? `可用场景：${sceneIds.join("、")}` : "请先确认包含场景的资产表，或为无场景镜头省略 sceneId"]
        : []).join("\n");
}

export type DramaWorkspaceTab="editor"|"video"|"runs"|"history";

export function DramaPipelineNodePanel({ node, onChange, onCreateVideoConfigs, videoConfigs, onRefreshVideoConfig, onOpenVideoConfig, onCreateReferenceConfig, onPickCanvasImage, onCreateDramaShotGroup, projectId, upstreamText = "", upstreamContext = "", upstreamArtifacts = [], supplementalEpisodes = [], assetUsage = {}, confirmedAssetPlan, savedAssetReferences, mergedReferences, legacyAssetPlanning = false, imageNodes = [], productionContext = "", productionStyle, onOpenVersions, onConfirmVersion, onBeforeDramaRun, onAdoptDramaRun, onMigrateDramaSequences, onAdoptDramaAssetCandidate, versionBusy = false, workspaceMode = false, workspaceTab = "editor", onPendingChange, initialEpisodeId, initialShotId }: {
    node: CanvasNodeData;
    onChange: (patch: Partial<CanvasNodeData["metadata"]>) => void;
    onCreateVideoConfigs?: (inputs: ReturnType<typeof buildDramaVideoInput>[], batch: boolean) => DramaBatchCreateResult|void;
    onCreateDramaShotGroup?: (shotIds:string[])=>Promise<void>;
    videoConfigs?: ReadonlyMap<string, CanvasNodeData>;
    onOpenVideoConfig?: (id: string) => void;
    onRefreshVideoConfig?: (id:string,input:ReturnType<typeof buildDramaVideoInput>,fields:{prompt:boolean;duration:boolean;references?:boolean;overwrite:boolean})=>void;
    onCreateReferenceConfig?: (assetName: string, prompt: string) => void;
    onPickCanvasImage?: (onPick: (storageKey: string) => void) => void;
    projectId?: string;
    upstreamText?: string;
    upstreamContext?: string;
    upstreamArtifacts?: string[];
    assetUsage?: DramaAssetUsage;
    supplementalEpisodes?: {id:string;title:string;synopsis:string;events:string[];ending:string}[];
    confirmedAssetPlan?: string;
    savedAssetReferences?: string;
    mergedReferences?: DramaAssetReference[];
    legacyAssetPlanning?: boolean;
    productionContext?: string;
    productionStyle?: string;
    onOpenVersions?: () => void;
    onConfirmVersion?: (draft: string) => Promise<void>;
    onBeforeDramaRun?: () => Promise<unknown>;
    onAdoptDramaRun?: (path:string,shotIds?:string[],expectedRevision?:number,episodeReview?:EpisodeAdoptionSelection) => Promise<void>;
    onMigrateDramaSequences?: (path:string,command:Record<string,unknown>) => Promise<void>;
    onAdoptDramaAssetCandidate?: (path:string,command:Record<string,unknown>) => Promise<(CanvasBackendProject&{mapping:AssetAdoptionMapping})|void>;
    versionBusy?: boolean;    /** Full editor only: host outside CanvasNode, no nested Modal. */
    workspaceMode?: boolean;
    workspaceTab?: DramaWorkspaceTab;
    onPendingChange?:WorkspacePendingRegistration;
    initialEpisodeId?: string;
    initialShotId?: string;
    imageNodes?: CanvasNodeData[];
}) {
    const stage = Object.entries(DRAMA_PIPELINE_NODE_TYPES).find(([, type]) => type === node.type)?.[0] as DramaPipelineStage | undefined;
    const storedDraft = node.metadata?.dramaDraft || node.metadata?.dramaConfirmed || node.metadata?.content || "";
    const [localDraft, setDraft] = useState(storedDraft);
    const [localConfirmed, setConfirmed] = useState(String(node.metadata?.dramaConfirmed ?? ""));
    const [validation, setValidation] = useState<string>("");
    const feedback=useDramaFeedback();
    const feedbackApi=workspaceMode?feedback?.api:undefined;
    const report=(key:string,level:DramaFeedbackLevel,title:string,detail?:string)=>{
        if(feedbackApi)feedbackApi.notify(key,level,title,detail);
        else setValidation(detail?title+"："+detail:title);
    };
    const reportError=(key:string,error:unknown,fallback:string)=>{
        const {title,detail}=describeDramaFeedbackError(error,fallback);
        report(key,"error",title,detail);
    };
    const [localGenerating, setGenerating] = useState(false);
    const generating=localGenerating||Boolean(workspaceMode&&feedback?.task);
    const [assetEditing,setAssetEditing]=useState(false);
    const [videoEditing,setVideoEditing]=useState(false);
    const [,setAssetDirectory]=useAssetDirectory();
    const openAdoptedAsset=useContext(AssetReviewNavigationContext);
    const openCandidates=useContext(DramaCandidateNavigationContext);
    const [scopeOpen,setScopeOpen]=useState(false);
    // Both storyboard tabs share the same footer; close an open range menu when switching tabs.
    useEffect(()=>setScopeOpen(false),[workspaceMode,workspaceTab]);
    const [storyboardView, setStoryboardView] = useState<"shots" | "video">("shots");
    const [assetEditorExpanded, setAssetEditorExpanded] = useState(workspaceMode);
    const [targetEpisodes, setTargetEpisodes] = useState(Number(node.metadata?.targetEpisodes ?? 10));
    const upstreamKey=JSON.stringify(upstreamArtifacts);
    const upstream=useMemo(()=>upstreamArtifacts.map(readDraft),[upstreamKey]);
    const assetPlanning = stage === "assets";
    const referenceEditing = stage === "asset_references";
    const mergedEditing = assetPlanning && !legacyAssetPlanning;
    const episodePlanning = stage === "episodes";
    const storyboard = stage === "storyboard";
    const [requestedEpisode,setSelectedEpisode] = useState(initialEpisodeId ?? "");
    const [assetEpisode,setAssetEpisode] = useState("");
    const [requestedSequence,setSelectedSequence] = useState("");
    const [requestedRunShot,setSelectedRunShot] = useState(initialShotId ?? "");
    const [editorShotId,setEditorShotId]=useState(initialShotId??"");
    const navigateStoryboardEditor=useContext(DramaStoryboardNavigationContext);
    const scopeFocus=useContext(DramaStoryboardScopeContext);
    const [runs,setRuns] = useState<DramaRun[]>([]);
    const [candidateEdit,setCandidateEdit]=useState<{runId:string;key:string}|null>(null);
    const candidateEditRef=useRef<typeof candidateEdit>(null);
    const candidateReadEpoch=useRef(0);
    const candidateFlights=useRef(new Set<string>());
    const [candidateConfirmations,setCandidateConfirmations]=useState<string[]>([]);
    const changeCandidateConfirming=useCallback((runId:string,confirming:boolean)=>{
        setCandidateConfirmations(current=>confirming===current.includes(runId)?current:confirming?[...current,runId]:current.filter(id=>id!==runId));
    },[]);
    const changeCandidateEditing=useCallback((runId:string,key:string|null)=>{
        if(!key&&candidateEditRef.current?.runId!==runId)return;
        const next=key?{runId,key}:null;
        candidateEditRef.current=next;candidateReadEpoch.current++;setCandidateEdit(next);
    },[]);
    // A list/detail response initiated before a mutation cannot revive an
    // excluded candidate or overwrite the newly saved version.
    const candidateMutationRef=useRef(false);
    const [candidateMutationBusy,setCandidateMutationBusy]=useState(false);

    const [expandedRuns,setExpandedRuns] = useState<Record<string,boolean>>({});
    const [selectedCandidates,setSelectedCandidates] = useState<Record<string,string[]>>({});
    const [runPreviews,setRunPreviews] = useState<Record<string,DramaRunPreview>>({});
    const runActionRef=useRef(false);
    const [runActionBusy,setRunActionBusy]=useState(false);
    const cancelFlights=useRef(new Set<string>());
    const [cancelBusyIds,setCancelBusyIds]=useState<string[]>([]);
    const runAction=async(title:string,fn:()=>Promise<void>)=>{
        if(runActionRef.current)return;
        const task=feedbackApi?.beginTask(title,undefined,true);
        if(feedbackApi&&!task)return;
        runActionRef.current=true;setRunActionBusy(true);task?.phase("等待操作结果");
        try{await fn();}finally{task?.end();runActionRef.current=false;setRunActionBusy(false);}
    };
    const [sequenceMigration,setSequenceMigration] = useState<DramaSequenceMigration>();
    const [sequenceChoices,setSequenceChoices] = useState<Record<string,string>>({});
    const [dependencyReport,setDependencyReport] = useState<{status:string;changes:{nodeId:string;kind:string;entryIds:string[]}[];impact?:{assetIds:string[];episodeIds:string[];sequenceIds:string[];shotIds:string[];mediaShotIds:string[];configIds:string[];needsReview:string[];pending?:{assetIds:string[];episodeIds:string[];sequenceIds:string[];shotIds:string[];configIds:string[];visualConfigIds?:string[];needsReview:string[]}}}>();
    const upstreamImpact=dependencyReport?.impact;
    const hasUpstreamImpactDetails=Boolean(dependencyReport?.changes.length ||
        (upstreamImpact && (["assetIds","episodeIds","sequenceIds","shotIds","mediaShotIds","configIds","needsReview"] as const)
            .some(key=>upstreamImpact[key].length>0)) ||
        (upstreamImpact?.pending && Object.values(upstreamImpact.pending).some(ids=>ids?.length)));
    const runPath = `/api/v1/projects/${encodeURIComponent(projectId ?? "")}/drama-pipeline/runs`;
    const changeCandidate=async(run:DramaRun,method:"PATCH"|"DELETE",entryId?:string,changes?:EpisodeCandidateChanges|WholeEpisodeChanges,wholeEpisode=false)=>{
        if(candidateMutationRef.current||runActionRef.current)throw Error("候选操作正在进行");
        const task=feedbackApi?.beginTask(method==="PATCH"?"正在保存剧集候选":"正在删除候选",undefined,true);
        if(feedbackApi&&!task)throw Error("请等待当前操作完成");
        candidateMutationRef.current=true;candidateReadEpoch.current++;setCandidateMutationBusy(true);
        const base=`${runPath}/${encodeURIComponent(run.id)}${entryId?"/episodes/"+encodeURIComponent(entryId):""}`;
        const expectedRevision=candidateRevision(run);
        try{
            const updated=await canvasApi<DramaRun>(method==="DELETE"?base+"?expectedRevision="+expectedRevision:base,method,
                method==="PATCH"?{expectedRevision,changes,...(wholeEpisode?{wholeEpisode:true}:{})}:undefined);
            candidateReadEpoch.current++;
            setRuns(current=>updated.status==="discarded"?current.filter(item=>item.id!==run.id):current.map(item=>item.id===run.id?updated:item));
            if(updated.status==="discarded")setExpandedRuns(current=>{const next={...current};delete next[run.id];return next;});
            report("candidate-edit:"+run.id,"success",method==="PATCH"?"候选已保存，正式草案未改变":entryId?"已移除本集候选":"已删除生成记录");
        }catch(error){reportError("candidate-edit:"+run.id,error,"候选操作失败，请检查后重试");throw error;}
        finally{candidateReadEpoch.current++;candidateMutationRef.current=false;setCandidateMutationBusy(false);task?.end();}
    };
    const readEpisodeRunDetails=(run:DramaRun,force=false)=>{
        if(candidateMutationRef.current||candidateEditRef.current?.runId===run.id||!force&&hasEpisodeDetails(run))return;
        const epoch=candidateReadEpoch.current,key=run.id+":"+candidateRevision(run)+":"+epoch;
        if(candidateFlights.current.has(key))return;
        candidateFlights.current.add(key);
        void canvasApi<DramaRun>(`${runPath}/${encodeURIComponent(run.id)}`,"GET")
            .then(updated=>{
                if(epoch!==candidateReadEpoch.current||candidateMutationRef.current)return;
                if(updated.id!==run.id)return;
                setRuns(current=>current.flatMap(item=>item.id!==run.id?[item]:
                    updated.status==="discarded"?[]:candidateRevision(updated)<candidateRevision(item)||item.status==="adopted"&&updated.status!=="adopted"?[item]:[updated]));
                feedbackApi?.clear("run-detail:"+run.id);
            }).catch(error=>{if(epoch===candidateReadEpoch.current)reportError("run-detail:"+run.id,error,"无法读取候选详情");})
            .finally(()=>candidateFlights.current.delete(key));
    };

    const loadRunDetails=(run:DramaRun)=>{
        if(episodePlanning){if(run.status==="ready"||run.status==="adopted")readEpisodeRunDetails(run);return;}
        if(!run.candidate?.shots?.length&&!run.candidate?.episodes?.length)void canvasApi<DramaRun>(`${runPath}/${encodeURIComponent(run.id)}`,"GET")
            .then(updated=>{setRuns(current=>current.map(item=>item.id===run.id?updated:item));feedbackApi?.clear("run-detail:"+run.id);})
            .catch(error=>reportError("run-detail:"+run.id,error,"无法读取候选详情"));
        if(storyboard&&["ready","adopted"].includes(run.status))
            void canvasApi<DramaRunPreview>(`${runPath}/${encodeURIComponent(run.id)}/preview`,"GET")
                .then(preview=>{setRunPreviews(current=>({...current,[run.id]:preview}));feedbackApi?.clear("run-preview:"+run.id);})
                .catch(error=>reportError("run-preview:"+run.id,error,"无法获取分镜差异预览"));
    };
    useEffect(()=>{
        const id=feedback?.focusRunId;
        if(!workspaceMode||workspaceTab!=="runs"||!id)return;
        const run=runs.find(item=>item.id===id&&item.status==="ready");
        if(!run)return;
        feedbackApi?.consumeRun(id);
        setExpandedRuns({[id]:true});
        loadRunDetails(run);
    },[workspaceMode,workspaceTab,feedback?.focusRunId,runs,feedbackApi]);
    useEffect(() => {
        if ((!storyboard&&!episodePlanning) || !projectId || (workspaceMode && workspaceTab!=="runs" && !generating && !runs.some(run=>run.status==="running"))) return;
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = () => {
            const epoch=candidateReadEpoch.current;
            if(episodePlanning&&candidateMutationRef.current){timer=setTimeout(refresh,3000);return;}
            void canvasApi<DramaRun[]>(`${runPath}?nodeId=${encodeURIComponent(node.id)}`,"GET")
            .then(result => { if(active&&(!episodePlanning||epoch===candidateReadEpoch.current&&!candidateMutationRef.current)) {
                feedbackApi?.clear("run-list");setRuns(current=>mergeCandidateRuns(current,result,candidateEditRef.current?.runId));
            } })
            .catch(error => { if(active) reportError("run-list",error,"无法读取候选运行记录"); })
            .finally(() => { if(active) timer=setTimeout(refresh,3000); });
        };
        void refresh();
        return () => { active = false; clearTimeout(timer); };
    }, [node.id, projectId, runPath, storyboard,episodePlanning,workspaceMode,workspaceTab,generating,runs.some(run=>run.status==="running")]);
    const missingEpisodeDetails=episodePlanning?runs.filter(run=>expandedRuns[run.id]&&["ready","adopted"].includes(run.status)&&!hasEpisodeDetails(run))
        .map(run=>run.id+":"+candidateRevision(run)+":"+run.status).join("|"):"";
    useEffect(()=>{
        if(!episodePlanning||workspaceMode&&workspaceTab!=="runs"||candidateEdit||candidateMutationBusy)return;
        for(const run of runs)if(expandedRuns[run.id]&&["ready","adopted"].includes(run.status)&&!hasEpisodeDetails(run))readEpisodeRunDetails(run);
    },[episodePlanning,workspaceMode,workspaceTab,missingEpisodeDetails,candidateEdit,candidateMutationBusy]);
    const versioned = assetPlanning || episodePlanning || storyboard;
    const [dependencyLoading,setDependencyLoading]=useState(false);
    const [dependencyError,setDependencyError]=useState("");
    const dependencyPath=`/api/v1/projects/${encodeURIComponent(projectId??"")}/drama-pipeline/dependencies?nodeId=${encodeURIComponent(node.id)}`;
    const loadDependencies=(signal?:AbortSignal,manual=false)=>{
        setDependencyLoading(true);setDependencyError("");
        return canvasApi<NonNullable<typeof dependencyReport>>(dependencyPath,"GET",undefined,signal)
            .then(result=>{if(!signal?.aborted){setDependencyReport(result);if(manual)report("impact-refresh","success","已刷新上游影响");}})
            .catch(error=>{if(!signal?.aborted)setDependencyError(error instanceof Error?error.message:"无法检查上游更新");})
            .finally(()=>{if(!signal?.aborted)setDependencyLoading(false);});
    };
    useEffect(()=>{
        if(!workspaceMode||workspaceTab!=="history"||!versioned||!projectId)return;
        const controller=new AbortController();
        void loadDependencies(controller.signal);
        return ()=>controller.abort();
    },[workspaceMode,workspaceTab,versioned,projectId,dependencyPath]);
    const readsStoredDraft = assetPlanning || versioned;
    const draft = readsStoredDraft ? storedDraft : localDraft;
    const confirmed = readsStoredDraft ? node.metadata?.dramaConfirmed ?? "" : localConfirmed;
    const episodeDraft = useMemo(()=>episodePlanning ? readEpisodeDraft(draft) : null,[episodePlanning,draft]);
    const storyboardDraft = useMemo(()=>storyboard ? readStoryboardDraft(draft) : null,[storyboard,draft]);
    const inlineEditor = assetPlanning || referenceEditing || versioned;
    const previous = useMemo(()=>assetPlanning ? readAssetDraft(draft) : readDraft(draft),[assetPlanning,draft]);
    const liveAssets = useMemo(()=>readDraft(confirmedAssetPlan ?? "")?.assets,[confirmedAssetPlan]);
    const assets = assetPlanning ? previous?.assets??[] : liveAssets ?? upstream.find(item => Array.isArray(item?.assets))?.assets ?? previous?.assets ?? [];
    const savedReferences = useMemo(()=>readDraft(savedAssetReferences ?? "")?.references,[savedAssetReferences]);
    const upstreamReferences = (mergedReferences ? referencesForDramaAssets(liveAssets ?? [], mergedReferences) : undefined) ??
        (Array.isArray(savedReferences) ? savedReferences : undefined) ??
        upstream.find(item => Array.isArray(item?.references))?.references;
    const shots = storyboard ? storyboardDraft?.shots ?? [] :
        upstream.find(item => Array.isArray(item?.shots))?.shots ?? previous?.shots ?? [];
    const linkedEpisodes = useMemo(()=>storyboard ? upstreamArtifacts.flatMap(item => readEpisodeDraft(item)?.episodes ?? []) : [],[storyboard,upstreamKey]);
    // Resolve the default against live confirmed upstream episodes, including after hydration.
    const selectedEpisode = storyboard
        ? (linkedEpisodes.find(episode=>episode.id===requestedEpisode)
            ?? (!requestedEpisode&&initialShotId?linkedEpisodes.find(episode=>episode.id===shots.find(shot=>shot.id===initialShotId)?.episodeId):undefined)
            ?? linkedEpisodes[0])?.id ?? ""
        : requestedEpisode;
    const selectedSequence = storyboard&&linkedEpisodes.find(episode=>episode.id===selectedEpisode)?.sequences?.some(sequence=>sequence.id===requestedSequence)
        ? requestedSequence : "";
    const selectedRunShot = storyboard&&shots.some(shot=>shot.id===requestedRunShot&&shot.episodeId===selectedEpisode&&(!selectedSequence||shot.sequenceId===selectedSequence))
        ? requestedRunShot : "";
    useEffect(()=>{
        if(!storyboard||!selectedEpisode)return;
        if(requestedEpisode!==selectedEpisode){
            setSelectedEpisode(selectedEpisode);setSelectedSequence("");setSelectedRunShot(selectedRunShot);
        }else{
            if(requestedSequence!==selectedSequence)setSelectedSequence(selectedSequence);
            if(requestedRunShot!==selectedRunShot)setSelectedRunShot(selectedRunShot);
        }
    },[storyboard,selectedEpisode,selectedSequence,selectedRunShot,requestedEpisode,requestedSequence,requestedRunShot]);
    useEffect(()=>{
        const focus=scopeFocus?.[0];
        if(!storyboard||workspaceTab!=="editor"||!focus)return;
        setSelectedEpisode(focus.episodeId);setSelectedSequence(focus.sequenceId??"");setSelectedRunShot(focus.shotId??"");
        if(focus.shotId)setEditorShotId(focus.shotId);
        scopeFocus?.[1](null);
    },[storyboard,workspaceTab,scopeFocus]);
    const hasConfirmedStoryboardAssets = Array.isArray(liveAssets)||upstream.some(item=>Array.isArray(item?.assets));
    const storyboardGenerationBlock = !hasConfirmedStoryboardAssets?"请先确认并连接资产规划节点":
        !linkedEpisodes.length?"请先确认并连接包含剧集的剧集规划节点":
        !selectedEpisode?"请选择生成范围：剧集":"";
    const scenes = assets.filter(asset => asset.kind === "scene");
    const invalidSceneIds = stage === "storyboard" ? [...new Set(shots.flatMap(shot =>
        shot?.sceneId && !scenes.some(scene => scene.id === shot.sceneId) ? [shot.sceneId] : [],
    ))] : [];
    const replaceScene = (oldId: string, newId: string) => {
        const nextShots = shots.map(shot => {
            if (shot?.sceneId !== oldId) return shot;
            const updated = { ...shot, sceneId: newId };
            if (!scenes.find(scene => scene.id === newId)?.variants?.some(variant => variant.id === shot.sceneVariantId)) {
                delete updated.sceneVariantId;
            }
            return updated;
        });
        const next = JSON.stringify({ ...storyboardDraft, shots: nextShots });
        onChange({dramaDraft: next});
        report("replace-scene","success","已替换场景引用，请检查并确认草案");
    };
    const storedReferences = mergedEditing ? node.metadata?.dramaAssetReferences : previous?.references;
    const references = referenceEditing || mergedEditing ? dramaAssetSlots(assets).map(slot => ({
        ...slot, imageStorageKeys:dramaReferenceImageKeys(storedReferences?.find(ref =>
            ref.assetId === slot.assetId && ref.variantId === slot.variantId)),
    })) : upstreamReferences ?? previous?.references ?? [];
    const parsedSnapshot: DramaPipelineSnapshot = {version:1,stage:stage ?? "source",revision:1,inputRevisions:{},assets,references:storyboard ? [] : references,shots};
    const confirmedShots = useMemo(()=>storyboard ? readStoryboardDraft(confirmed)?.shots ?? [] : [],[storyboard,confirmed]);
    const videoSnapshot = { ...parsedSnapshot, references };
    const effectiveStoryboardView = workspaceMode ? (workspaceTab==="video"?"video":"shots") : storyboardView;
    const videoInputs = effectiveStoryboardView==="video"?confirmedShots.map(shot => buildDramaVideoInput(videoSnapshot, shot)):[];

    const images = imageNodes.flatMap(item => {
        const metadata = item.metadata;
        const keys = [metadata?.storageKey, ...(metadata?.images ?? []).map(image => image.storageKey)];
        return [...new Set(keys)].flatMap(key => key && /^cas:[a-f0-9]{64}$/.test(key) ? [{key,title:item.title}] : []);
    });
    const updateReference = (assetId: string, variantId: string | undefined, key: string, remove = false) => {
        if(generating||versionBusy||assetEditing)return;
        const slot = references.find(ref => ref.assetId === assetId && ref.variantId === variantId);
        if (!slot) return;
        const keys = dramaReferenceImageKeys(slot);
        const imageStorageKeys = remove ? keys.filter(item => item !== key) : [...new Set([...keys, key])];
        const referencesToKeep = (mergedEditing ? storedReferences ?? [] : references)
            .filter(ref => ref.assetId !== assetId || ref.variantId !== variantId);
        const referencesNext = [...referencesToKeep, {...slot, imageStorageKeys}];
        if (mergedEditing) {
            onChange({dramaAssetReferences:referencesNext});
            return;
        }
        const next = JSON.stringify({ ...parsedSnapshot, references:referencesNext }, null, 2);
        setDraft(next);
        onChange({ dramaDraft: next });
    };
    const config = useEffectiveConfig();
    const appearance = useThemeStore(state => state.theme);
    const theme = canvasThemes[appearance];
    const control = inlineEditor ? dramaNodeControl(theme) : undefined;
    const assetConfirmed = Boolean(confirmed && draft === confirmed);
    const inlineReady = referenceEditing ? references.length > 0 : episodePlanning ? Boolean(episodeDraft?.episodes.length) : storyboard ? shots.length > 0 : Boolean(previous);
    if (!stage) return null;
    if (stage === "first_frames") return <section className="rounded-xl p-4">
        <strong>首帧渲染存档</strong>
        {[...new Set([draft, confirmed].filter(Boolean))].map(content =>
            <pre key={content} className="max-h-48 overflow-auto whitespace-pre-wrap">{content}</pre>)}
    </section>;
    const ImpactContainer=workspaceMode?"section":"details";
    const ImpactHeading=workspaceMode?"header":"summary";
    const compactStoryboardActions=storyboard&&workspaceMode&&assetEditorExpanded&&
        (workspaceTab==="editor"||workspaceTab==="video");
    const scopeEpisode=linkedEpisodes.find(item=>item.id===selectedEpisode);
    const scopeLabel=selectedEpisode
        ? [scopeEpisode?.title||selectedEpisode,
           selectedSequence?(scopeEpisode?.sequences?.find(item=>item.id===selectedSequence)?.title||selectedSequence):"全部场次",
           selectedRunShot?("镜头 "+(shots.find(item=>item.id===selectedRunShot)?.order??selectedRunShot)):"全部镜头"].join(" · ")
        : "请选择要生成的剧集";
    const migrationPanel=storyboard&&selectedEpisode?(
        <details data-drama-sequence-migration="" className="min-w-0 space-y-2 rounded-lg border p-2 text-xs" style={{borderColor:theme.node.stroke,background:theme.node.fill,color:theme.node.text}}>
            <summary className="cursor-pointer py-1 font-medium">场次拆分／合并后的镜头引用迁移</summary>
            <p className="pt-2 text-xs leading-relaxed" style={{color:theme.node.muted}}>先确认新的剧集场次，再扫描旧镜头。场次一对多拆分时，必须逐镜指定新场次，不自动覆盖人工配置。</p>
            <Button size="small" style={control} disabled={!projectId||versionBusy} onClick={async()=>{
                try{
                    await onBeforeDramaRun?.();
                    const data=await canvasApi<DramaSequenceMigration>(
                        `/api/v1/projects/${encodeURIComponent(projectId??"")}/drama-pipeline/sequence-migration?nodeId=${encodeURIComponent(node.id)}&episodeId=${encodeURIComponent(selectedEpisode)}`,"GET");
                    setSequenceMigration(data);setSequenceChoices({});
                    report("scan-sequences","info",data.rows.length?"请审核每个旧镜头所属的新场次":"当前剧集没有需要迁移的旧镜头");
                }catch(error){reportError("scan-sequences",error,"场次迁移扫描失败");}
            }}>扫描场次引用</Button>
            {sequenceMigration?.episodeId===selectedEpisode&&<>
                {sequenceMigration.rows.map(row=><label key={row.shotId} className="grid min-w-0 gap-1 rounded-lg border p-2 text-xs" style={{borderColor:theme.node.stroke}}>
                    <span>镜头 {row.shotId} · 旧场次 {row.sourceSequenceId??"未指定"}</span>
                    <select aria-label={`镜头 ${row.shotId} 迁入场次`} className="min-w-0 rounded-md border p-1.5" style={control}
                        value={sequenceChoices[row.shotId]??""} onChange={event=>setSequenceChoices(old=>({...old,[row.shotId]:event.target.value}))}>
                        <option value="">保留原归属，暂不迁移</option>
                        {row.possibleSequenceIds.map(id=><option value={id} key={id}>{id}</option>)}
                    </select>
                    {row.status==="unresolved"&&<span>没有确定的继承关系，请先在剧集规划补充 replaces 关系。</span>}
                    {row.status==="choice_required"&&<span>拆场存在多个候选归属，必须人工选择。</span>}
                </label>)}
                <Button style={control} disabled={versionBusy||!Object.values(sequenceChoices).some(Boolean)} onClick={async()=>{
                    try{
                        const changes=sequenceMigration.rows.filter(row=>sequenceChoices[row.shotId]).map(row=>({
                            shotId:row.shotId,sequenceId:sequenceChoices[row.shotId],
                            expectedShotDigest:row.shotDigest,
                        }));
                        await onMigrateDramaSequences?.(
                            `/api/v1/projects/${encodeURIComponent(projectId??"")}/drama-pipeline/sequence-migration`,{
                                nodeId:node.id,episodeId:selectedEpisode,expectedRevision:sequenceMigration.projectRevision,
                                episodeDigest:sequenceMigration.episodeDigest,changes,
                            });
                        setSequenceMigration(undefined);setSequenceChoices({});
                        report("migrate-sequences","success","已迁移所选镜头，请重新检查并确认分镜");
                    }catch(error){reportError("migrate-sequences",error,"场次引用迁移失败，请重新扫描");}
                }}>确认迁移所选镜头</Button>
            </>}
        </details>
    ):null;
    const AssetFields=assetPlanning&&workspaceMode?DramaAssetWorkspaceFields:DramaAssetFields;
    const editor = <section className={inlineEditor ? assetEditorExpanded
        ? compactStoryboardActions?"flex h-full min-h-0 flex-col gap-2 text-sm":"flex h-full min-h-0 flex-col gap-4 text-sm"
        : dramaInlineNodeClass
        : "rounded-xl border border-slate-200 bg-white p-4 shadow-xl"}
        style={inlineEditor ? {color:theme.node.text} : undefined} data-canvas-no-zoom={inlineEditor ? "" : undefined}
        onWheel={inlineEditor ? event => event.stopPropagation() : undefined}
        onMouseDown={inlineEditor ? event => {
            if (event.target instanceof Element && event.target.closest("input, textarea, select, button, summary")) event.stopPropagation();
        } : undefined}
        onDoubleClick={inlineEditor ? event => event.stopPropagation() : undefined}
        onKeyDown={inlineEditor ? event => event.stopPropagation() : undefined}>
        {!workspaceMode&&<header className={`flex items-center justify-between gap-2 ${inlineEditor ? "" : "mb-3"}`}>
            {!assetEditorExpanded && <strong className={inlineEditor ? "text-sm" : undefined}>{DRAMA_PIPELINE_STAGE_LABELS[stage]}</strong>}
            {inlineEditor ? <div className="flex items-center gap-2">
                <DramaNodeStatus theme={theme} confirmed={assetConfirmed} />
                {versioned && onOpenVersions && !workspaceMode && <Button size="small" icon={<History size={14} />}
                    style={control} onClick={onOpenVersions}>历史版本</Button>}
                {!workspaceMode && !assetEditorExpanded && <button type="button" title="最大化编辑器" aria-label={`最大化${DRAMA_PIPELINE_STAGE_LABELS[stage]}`}
                    className="inline-grid size-7 place-items-center rounded-md border" style={control}
                    onClick={() => setAssetEditorExpanded(true)}><Maximize2 className="size-3.5" /></button>}
            </div> :
                <Tag color={confirmed ? "green" : "default"}>{confirmed ? "已确认" : "草案"}</Tag>}
        </header>}
        {assetPlanning && (!workspaceMode||workspaceTab==="runs") && node.metadata?.dramaAssetCandidate && <DramaAssetCandidates
            key={node.metadata.dramaAssetCandidate.id} assets={previous?.assets??[]}
            candidates={node.metadata.dramaAssetCandidate.assets} candidateId={node.metadata.dramaAssetCandidate.id} expanded={workspaceMode} disabled={generating||versionBusy}
            onDiscard={()=>onChange({dramaAssetCandidate:undefined})}
            onApply={async decisions=>{
                try{
                    const candidate=node.metadata?.dramaAssetCandidate;
                    if(!candidate)return;
                    if(candidate.baseline!==storedDraft)throw Error("资产草案已修改，请重新提取候选后审核");
                    if(!onAdoptDramaAssetCandidate)throw Error("原子资产合入服务未连接，不能直接修改草案");
                    await onBeforeDramaRun?.();
                    const adopted=await onAdoptDramaAssetCandidate(
                        `/api/v1/projects/${encodeURIComponent(projectId??"")}/drama-pipeline/asset-candidates/adopt`,{
                            nodeId:node.id,candidateId:candidate.id,decisions,
                        });
                    report("adopt-assets","success","已合入资产及受影响的分镜引用，请核对后确认资产");
                    if(adopted&&workspaceMode){
                        const saved=(adopted.document.nodes as CanvasNodeData[]).find(item=>item.id===node.id);
                        const savedAssets=readAssetDraft(saved?.metadata?.dramaDraft??"")?.assets;
                        const focus=savedAssets&&adopted.mapping&&adoptedAssetSelection(savedAssets,candidate.assets,adopted.mapping);
                        if(focus){setAssetDirectory(current=>({...current,...focus}));openAdoptedAsset?.();}
                    }
                }catch(error){if(!feedbackApi)reportError("adopt-assets",error,"资产合入失败");throw error;}
            }}/>}
        {assetPlanning&&workspaceMode&&workspaceTab==="runs"&&!node.metadata?.dramaAssetCandidate&&<p className="text-xs" style={{color:theme.node.muted}}>暂无待审核资产候选。请在资产编辑页生成资产候选。</p>}
        {versioned && (!workspaceMode || workspaceTab==="history") &&
         <ImpactContainer aria-label={workspaceMode?"上游影响检查":undefined}
             className={workspaceMode?"min-w-0 space-y-3 rounded-xl border p-3 text-xs":"text-xs"}
             style={workspaceMode?{borderColor:theme.node.stroke,background:theme.node.panel,color:theme.node.text}:undefined}>
             <ImpactHeading
                 className={workspaceMode?"flex flex-wrap items-center justify-between gap-2 border-b pb-3 font-semibold":"cursor-pointer"}
                 style={workspaceMode?{borderColor:theme.node.stroke}:undefined}
                 onClick={workspaceMode?undefined:()=>void loadDependencies()}>
                 <span className="flex items-center gap-2">
                     {workspaceMode&&<ShieldAlert size={14} style={{color:theme.node.muted}} aria-hidden="true"/>}
                     {workspaceMode?"依赖影响概览":"检查上游更新"}
                 </span>
                 {workspaceMode&&<Button size="small" aria-label="刷新上游影响"
                    icon={<RefreshCw size={13}/>} loading={dependencyLoading}
                    onClick={()=>void loadDependencies(undefined,true)} style={control}>刷新影响</Button>}
             </ImpactHeading>
             {dependencyError&&<DramaInlineFeedback theme={theme} level="error" error={dependencyError}/>}
             {dependencyLoading&&<DramaInlineFeedback theme={theme} level="info" pending>正在读取上游影响…</DramaInlineFeedback>}
            {dependencyReport&&!dependencyLoading&&!dependencyError && <DramaInlineFeedback theme={theme} level={dependencyReport.status==="current"?"info":"warning"}>{dependencyReport.status==="current"?"当前确认结果与上游一致":
                dependencyReport.status==="unknown"?"此版本缺少历史依赖，请核对后重新确认":"上游已有更新，请核对受影响条目后生成候选或重新确认"}</DramaInlineFeedback>}
            {!dependencyError&&!dependencyLoading&&dependencyReport?.changes.map(item=><p key={item.nodeId}>
                {item.kind==="disconnected"?"已断开":item.kind==="connected"?"新增连接":item.kind==="references_updated"?"参考图更新":item.kind==="visual_updated"?"美术设定更新":"内容更新"} · {item.entryIds.join("、")||item.nodeId}
            </p>)}
            {!dependencyError&&!dependencyLoading&&dependencyReport?.impact && hasUpstreamImpactDetails && <div className="mt-2 grid gap-1 rounded-lg border p-2 text-xs" aria-label="细粒度影响预览">
                {([
                    ["assetIds","关联资产"],["episodeIds","受影响剧集"],["sequenceIds","受影响场次"],
                    ["shotIds","需检查分镜"],["mediaShotIds","仅媒体参考图受影响的镜头"],
                    ["configIds","需检查视频配置"],
                ] as const).filter(([key])=>dependencyReport.impact?.[key]?.length).map(([key,label])=>
                    <p key={key} className="break-words">{label}：{dependencyReport.impact?.[key].join("、")}</p>)}
                {dependencyReport.impact.needsReview.length>0&&<p role="status" className="break-words">
                    部分旧引用缺少精确关系，需人工核对：{dependencyReport.impact.needsReview.join("、")}
                </p>}
                {dependencyReport.impact.pending &&
                    (dependencyReport.impact.pending.shotIds.length>0||dependencyReport.impact.pending.needsReview.length>0) &&
                    <div className="grid gap-1 border-t pt-2" aria-label="尚未确认的上游影响">
                        <strong>源头已有更新，但中间剧集／资产尚未重新确认：</strong>
                        {dependencyReport.impact.pending.episodeIds.length>0&&
                            <p>待核对剧集：{dependencyReport.impact.pending.episodeIds.join("、")}</p>}
                        {dependencyReport.impact.pending.sequenceIds.length>0&&
                            <p>待核对场次：{dependencyReport.impact.pending.sequenceIds.join("、")}</p>}
                        {dependencyReport.impact.pending.shotIds.length>0&&
                            <p>可能受影响的镜头：{dependencyReport.impact.pending.shotIds.join("、")}</p>}
                        {dependencyReport.impact.pending.configIds.length>0&&
                            <p>可能受影响的视频配置：{dependencyReport.impact.pending.configIds.join("、")}</p>}
                        {(dependencyReport.impact.pending.visualConfigIds?.length??0)>0&&
                            <p>确实采用旧影片风格、需复核的 Config：{dependencyReport.impact.pending.visualConfigIds?.join("、")}</p>}
                        {dependencyReport.impact.pending.needsReview.length>0&&
                            <p>引用待核对：{dependencyReport.impact.pending.needsReview.join("、")}</p>}
                        <DramaInlineFeedback theme={theme}>这是预警，不表示当前确认分镜已经变动；请先审核并确认中间阶段。</DramaInlineFeedback>
                    </div>}

                {storyboard&&<div className="flex flex-wrap gap-1.5 border-t pt-2" aria-label="从影响范围选择局部重跑">
                    {dependencyReport.impact.episodeIds.filter(id=>linkedEpisodes.some(episode=>episode.id===id)).map(id=>
                        <Button key={"ep-"+id} size="small" onClick={()=>{
                            setSelectedEpisode(id);setSelectedSequence("");setSelectedRunShot("");
                            if(workspaceMode)navigateStoryboardEditor?.({episodeId:id});
                            report("impact-scope","info","已选择受影响剧集，点击生成分镜候选后执行");
                        }}>按集重跑 · {linkedEpisodes.find(episode=>episode.id===id)?.title??id}</Button>)}
                    {dependencyReport.impact.sequenceIds.flatMap(value=>{
                        const shot=shots.find(item=>item.episodeId+"/"+item.sequenceId===value);
                        if(!shot)return [];
                        return [<Button key={"seq-"+value} size="small" onClick={()=>{
                            setSelectedEpisode(shot.episodeId);setSelectedSequence(shot.sequenceId??"");setSelectedRunShot("");
                            if(workspaceMode)navigateStoryboardEditor?.({episodeId:shot.episodeId,sequenceId:shot.sequenceId});
                            report("impact-scope","info","已选择受影响场次，点击生成分镜候选后执行");
                        }}>按场重跑 · {linkedEpisodes.find(ep=>ep.id===shot.episodeId)?.sequences?.find(seq=>seq.id===shot.sequenceId)?.title??value}</Button>];
                    })}
                    {dependencyReport.impact.shotIds.flatMap(id=>{
                        const shot=shots.find(item=>item.id===id);
                        if(!shot)return [];
                        return [<Button key={"shot-"+id} size="small" onClick={()=>{
                            setSelectedEpisode(shot.episodeId);setSelectedSequence(shot.sequenceId??"");setSelectedRunShot(id);
                            if(workspaceMode)navigateStoryboardEditor?.({episodeId:shot.episodeId,sequenceId:shot.sequenceId,shotId:id});
                            report("impact-scope","info","已选择受影响镜头，点击生成分镜候选后执行");
                        }}>按镜重跑 · {linkedEpisodes.find(ep=>ep.id===shot.episodeId)?.title??shot.episodeId} · 镜头 {shot.order}</Button>];
                    })}
                </div>}
                <p>这里仅预览确认版本的影响；不会自动修改草案或视频 Config。可按集、场、镜生成候选，
                    在视频配置页逐项选择采用更新。</p>
            </div>}
        </ImpactContainer>}
        <div className={assetPlanning&&workspaceMode&&workspaceTab==="runs"?"contents":inlineEditor ? assetEditorExpanded ? "flex min-h-0 flex-1 flex-col gap-4" :
            "thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-1" : "contents"}
            onMouseDown={inlineEditor ? event => event.stopPropagation() : undefined}
            onPointerDown={inlineEditor ? event => event.stopPropagation() : undefined}>
        {(!workspaceMode||workspaceTab==="editor"||workspaceTab==="video") && <>
        {inlineEditor ? <div className={assetEditorExpanded
            ? episodePlanning||storyboard||assetPlanning&&workspaceMode ? "flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden" : "thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1"
            : versioned ? "grid gap-3" : "contents"}>
            {assetPlanning&&projectId&&!workspaceMode&&<DramaCreativeScopeBrowser projectId={projectId} nodeId={node.id} kind="assets"/>}
            {episodePlanning ? <>
                <label className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5" style={control}>
                    <span className="flex min-w-0 flex-col gap-0.5"><strong className="text-xs font-semibold">规划目标集数</strong>
                     <span className="text-[11px]" style={{color:theme.node.muted}}>生成完整剧集计划时使用，调整不会直接修改现有条目</span></span>
                    <Input aria-label="剧集规划目标集数" size="small" className="!w-20 shrink-0" type="number" min={1} max={100} value={targetEpisodes} disabled={generating} style={control}
                        onChange={event => {
                            const count = Math.max(1, Math.min(100, Math.trunc(Number(event.target.value)) || 1));
                            setTargetEpisodes(count);
                            setValidation("");
                            onChange({targetEpisodes:count});
                        }} />
                </label>
                <DramaEpisodeFields episodes={episodeDraft?.episodes ?? []} initialEpisodeId={initialEpisodeId}
                    projectId={workspaceMode?projectId:undefined} nodeId={workspaceMode?node.id:undefined}
                    onWaitForDraftSave={workspaceMode&&workspaceTab==="editor"&&onBeforeDramaRun?async()=>{
                        await onBeforeDramaRun();
                    }:undefined}
                    onReloadEpisode={workspaceMode&&projectId&&workspaceTab==="editor"?async()=>{
                        await useCanvasStore.getState().loadProject(projectId);
                        await ensureCreativeNodesLoaded(projectId,[node.id]);
                    }:undefined}
                    onPatchEpisode={workspaceMode&&projectId&&workspaceTab==="editor"?async(entryId,expectedDigest,changes,sequenceId)=>{
                        await commitAssistantCanvasGraphWithSaveBarrier(projectId,()=>
                            canvasApi<CanvasBackendProject>(
                                `/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/entry-draft`,"PATCH",
                                {nodeId:node.id,kind:"episodes",entryId,expectedDigest,operationId:crypto.randomUUID(),
                                    changes,...(sequenceId?{sequenceId}:{})}),
                            {textVersionNodeId:node.id,keepCreativePointers:true,invalidateCreativeNodeId:node.id});
                        await ensureCreativeNodesLoaded(projectId,[node.id]);
                    }:undefined}
                    expanded={assetEditorExpanded} disabled={generating||versionBusy} control={control} onChange={episodes => {
                    const next = JSON.stringify({...episodeDraft,episodes});
                    setValidation("");
                    onChange({dramaDraft:next});
                }} />
                {draft && !episodeDraft && <p role="alert">这份剧集草案格式无法读取，请重新生成。</p>}
            </> : storyboard ? <>
                {!workspaceMode&&<div role="group" aria-label="分镜配置视图" className="grid grid-cols-2 gap-1 rounded-xl border p-1" style={control}>
                    {([{id:"shots", label:"镜头编辑"}, {id:"video", label:"批量创建配置"}] as const).map(view =>
                        <button key={view.id} type="button" aria-pressed={storyboardView === view.id}
                            className="rounded-lg px-2 py-1.5 font-medium focus-visible:outline focus-visible:outline-2"
                            style={storyboardView === view.id ? {background:theme.toolbar.activeBg, color:theme.toolbar.activeText} : undefined}
                            disabled={videoEditing} onClick={() => setStoryboardView(view.id)}>{view.label}</button>)}
                </div>}
                {effectiveStoryboardView==="shots"&&<div className={assetEditorExpanded ? "flex min-h-0 min-w-0 flex-1 flex-col gap-3" : "grid min-w-0 gap-3"}>
                    <DramaStoryboardFields shots={shots} episodes={linkedEpisodes} assets={assets} initialEpisodeId={initialEpisodeId} initialShotId={initialShotId}
                        selectedEpisodeId={selectedEpisode||undefined} onEpisodeChange={id=>{
                            setSelectedEpisode(id);setSelectedSequence("");setSelectedRunShot("");
                        }}
                        selectedShotId={editorShotId} onShotChange={setEditorShotId} navigationLocked={videoEditing}
                        production={node.metadata?.dramaShotProduction}
                        videoStatusFor={shot=>{
                            const published=confirmedShots.find(item=>item.id===shot.id);
                            if(!published)return "未确认";
                            const existing=videoConfigs?.get(shot.id);
                            if(existing&&JSON.stringify(published)!==JSON.stringify(shot))return "需确认";
                            return existing?"已配置":"待配置";
                        }}
                        renderVideoConfig={shot=>{
                            const published=confirmedShots.find(item=>item.id===shot.id);
                            const input=buildDramaVideoInput(videoSnapshot,published??shot);
                            return <Suspense fallback={<p role="status">正在加载视频配置…</p>}>
                                <DramaVideoConfigFields key={shot.id} embedded expanded confirmedInput={Boolean(published)}
                                    productionStyle={productionStyle} confirmedRevisionId={node.metadata?.dramaConfirmedVersionId}
                                    inputs={[input]} episodes={linkedEpisodes} initialEpisodeId={shot.episodeId} initialShotId={shot.id}
                                    onRefresh={onRefreshVideoConfig} configs={videoConfigs} missingCount={videoConfigs?.has(shot.id)?0:1}
                                    production={node.metadata?.dramaShotProduction}
                                    onProductionChange={(id,value)=>onChange({dramaShotProduction:{...node.metadata?.dramaShotProduction,[id]:value}})}
                                    images={images} projectId={projectId} onPendingChange={onPendingChange}
                                    onEditingChange={setVideoEditing} onWaitForSave={onBeforeDramaRun?async()=>{await onBeforeDramaRun();}:undefined}
                                    missingFor={item=>dramaVideoMissingReferenceIds(videoSnapshot,item.shot)}
                                    hasUnconfirmedChanges={Boolean(published&&JSON.stringify(published)!==JSON.stringify(shot))}
                                    disabled={generating||versionBusy} theme={theme}
                                    onCreateSelected={()=>{}}
                                    onAction={(item,existing)=>{
                                        if(existing)onOpenVideoConfig?.(existing.id);
                                        else onCreateVideoConfigs?.([item],false);
                                    }}/>
                            </Suspense>;
                        }}
                        projectId={workspaceMode?projectId:undefined} nodeId={workspaceMode?node.id:undefined}
                        onWaitForDraftSave={workspaceMode&&workspaceTab==="editor"&&onBeforeDramaRun?async()=>{
                            await onBeforeDramaRun();
                        }:undefined}
                        onReloadShot={workspaceMode&&projectId&&workspaceTab==="editor"?async()=>{
                            await useCanvasStore.getState().loadProject(projectId);
                            await ensureCreativeNodesLoaded(projectId,[node.id]);
                        }:undefined}
                        onPatchShot={workspaceMode&&projectId&&workspaceTab==="editor"?async (shotId,expectedDigest,changes)=>{
                            await commitAssistantCanvasGraphWithSaveBarrier(projectId,()=>
                                canvasApi<CanvasBackendProject>(
                                    `/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline/shot-draft`,"PATCH",
                                    {nodeId:node.id,shotId,expectedDigest,operationId:crypto.randomUUID(),changes}),
                                {keepCreativePointers:true,invalidateCreativeNodeId:node.id});
                            await ensureCreativeNodesLoaded(projectId,[node.id]);
                        }:undefined}
                        expanded={assetEditorExpanded} disabled={generating || versionBusy} control={control} onChange={nextShots => {
                            onChange({dramaDraft:JSON.stringify({...storyboardDraft,shots:nextShots})});
                            setValidation("");
                        }} />
                    {draft && !storyboardDraft && <p role="alert">这份分镜草案格式无法读取，可在下方修正或重新生成。</p>}
                    <details className="shrink-0 text-xs">
                        <summary>编辑结构化草案</summary>
                        <TextArea aria-label="分镜草案 JSON" value={draft} disabled={generating || versionBusy || videoEditing}
                            style={control} autoSize={{minRows:3,maxRows:10}} onChange={event => {
                                onChange({dramaDraft:event.target.value});
                                setValidation("");
                            }} />
                    </details>
                </div>}
                {effectiveStoryboardView==="video" && <div className={assetEditorExpanded
                    ?"flex min-h-0 min-w-0 flex-1 flex-col":"min-w-0"}>
                    <Suspense fallback={<p role="status">正在加载批量创建配置…</p>}>
                        <DramaBatchConfigPanel productionStyle={productionStyle} confirmedRevisionId={node.metadata?.dramaConfirmedVersionId}
                            inputs={videoInputs} episodes={linkedEpisodes} initialEpisodeId={selectedEpisode}
                            configs={videoConfigs}
                            canLocate={id=>shots.some(shot=>shot.id===id)}
                            onLocate={!workspaceMode||navigateStoryboardEditor?(id,episodeId)=>{
                                setSelectedEpisode(shots.find(shot=>shot.id===id)?.episodeId??episodeId);setSelectedSequence("");setSelectedRunShot("");setEditorShotId(id);
                                if(workspaceMode)navigateStoryboardEditor?.();else setStoryboardView("shots");
                            }:undefined}
                            production={node.metadata?.dramaShotProduction}
                            missingFor={input=>dramaVideoMissingReferenceIds(videoSnapshot,input.shot)}
                            disabled={generating||versionBusy} theme={theme}
                            onCreateSelected={selected=>{if(!onCreateVideoConfigs)throw Error("视频配置创建服务未连接");return onCreateVideoConfigs(selected,true);}}
                            onCreateBatch={onCreateDramaShotGroup}/>
                    </Suspense>                </div>}
            </> : <AssetFields key={assetPlanning&&workspaceMode?workspaceTab:undefined} references={references} usage={assetUsage} assets={assets} theme={theme} expanded={assetEditorExpanded} disabled={generating||versionBusy} onPendingChange={onPendingChange} onEditingChange={setAssetEditing}
                loading={Boolean(node.metadata?.creativePayloadRef)}
                onPatchAsset={assetPlanning&&workspaceMode&&projectId?(baseline,changes,variantId)=>saveAssetEntry(projectId,node.id,baseline,changes,variantId):undefined}
                onReloadAsset={assetPlanning&&workspaceMode&&projectId?async()=>{await onBeforeDramaRun?.();await useCanvasStore.getState().loadProject(projectId);await ensureCreativeNodesLoaded(projectId,[node.id]);}:undefined}
                onChange={assetPlanning ? nextAssets => {
                const next = JSON.stringify({...previous, assets:nextAssets});
                setDraft(next);
                setValidation("");
                onChange({dramaDraft:next});
            } : undefined} renderReferences={referenceEditing || mergedEditing ? (asset, variantId) => <div className="min-w-0 space-y-3">
                {references.filter(reference => reference.assetId === asset.id && (!mergedEditing || reference.variantId === variantId)).map(reference => {
                    const variant = asset.variants?.find(item => item.id === reference.variantId);
                    const name = reference.variantId ? variant?.name || (asset.kind==="character"?"未命名造型":"未命名变体") : asset.name || "未命名资产";
                    const keys = dramaReferenceImageKeys(reference);
                    return <section key={reference.variantId ?? asset.id} className="min-w-0 space-y-3 rounded-xl border p-3" style={{...control,background:theme.node.code.surface}}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0"><h3 className="break-words text-sm font-semibold">{name}</h3>
                                <span className="text-[11px]" style={{color:theme.node.muted}}>{reference.variantId?(asset.kind==="character"?"角色造型":"资产变体"):"基础参考图"}</span></div>
                            <span className="text-xs" style={{color:theme.node.muted}}>{keys.length ? `已选 ${keys.length} 张` : "待选参考图"}</span>
                        </div>
                        {(keys.length>0||!assetEditorExpanded)&&<CanvasNodeReferenceBar nodeId={node.id}
                            references={keys.map((key, index) => ({
                                id:key, nodeId:key, kind:"image", active:true,
                                title:images.find(image => image.key === key)?.title || `${name}参考图 ${index + 1}`,
                                label:`参考图 ${index + 1}`, previewUrl:canvasCasUrl(key) ?? undefined,
                            }))}
                            onDisconnect={generating||versionBusy||assetEditing?undefined:key => updateReference(asset.id, reference.variantId, key, true)}
                            onStartSelection={!assetEditing && !assetEditorExpanded && onPickCanvasImage
                                ? () => onPickCanvasImage(key => updateReference(asset.id, reference.variantId, key))
                                : undefined} />}
                        <div className="flex flex-wrap items-start gap-2">
                            {assetEditorExpanded&&<DramaReferenceImagePicker key={asset.id+":"+(reference.variantId??"base")}
                                name={name} images={images} boundKeys={keys} theme={theme} projectId={projectId}
                                disabled={generating||versionBusy||assetEditing||Boolean(node.metadata?.creativePayloadRef)}
                                onAdd={key=>updateReference(asset.id, reference.variantId, key)}/>}

                            <Button className="!min-h-8" size="small" style={control} disabled={!onCreateReferenceConfig||generating||versionBusy||assetEditing} onClick={() => {
                                onCreateReferenceConfig?.(asset.name, [
                                    `制作单张${asset.kind === "scene" ? "场景" : asset.kind === "prop" ? "道具" : "角色"}参考图。`,
                                    asset.name, asset.description, variant?.name, variant?.description,
                                ].filter(Boolean).join("\n"));
                                setAssetEditorExpanded(false);
                            }}>创建生图配置</Button>
                        </div>
                    </section>;
                })}
            </div> : undefined} />}
            {assetPlanning && draft && !previous && <p role="alert">这份资产草案无法读取，请重新生成或添加资产。</p>}
            {referenceEditing && !assets.length && <p style={{color:theme.node.muted}}>请先在已连接的资产规划节点确认资产。</p>}
        </div> : <TextArea value={draft} onChange={event => setDraft(event.target.value)} autoSize={{ minRows: 5, maxRows: 16 }}
            placeholder={stage === "source" ? "粘贴小说或剧本原文" : "填写或粘贴本阶段结构化草案"} />}
        {stage === "source" ? <label className="mt-2 block text-sm">导入文本文件
            <input className="ml-2" type="file" accept=".txt,.md,text/plain,text/markdown" onChange={async event => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                try { const content = await file.text(); setDraft(content); onChange({dramaDraft:content,content,sourceFilename:file.name}); report("load-source","success","原文已载入，保存节点以持久化"); }
                catch { report("load-source","error","无法读取该文本文件"); }
            }} />
        </label> : null}
        <div aria-label={compactStoryboardActions?"分镜生成与确认工具栏":episodePlanning&&assetEditorExpanded?"剧集生成与确认操作":assetPlanning&&assetEditorExpanded?"资产生成与确认操作":undefined}
         data-drama-storyboard-toolbar={compactStoryboardActions?"":undefined}
         className={compactStoryboardActions
            ? "flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-t pt-3 [&>button]:min-h-9"
            : inlineEditor&&(episodePlanning||assetPlanning)&&assetEditorExpanded
            ? "flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-3 [&>button]:min-h-9 [&>select]:min-h-9 [&>select]:min-w-[160px] [&>select]:max-w-full [&>select]:flex-1 [&>select]:rounded-lg [&>select]:border [&>select]:px-3 [&>select]:py-1.5"
            : inlineEditor
            ? `grid min-w-0 grid-cols-2 items-center gap-2 pt-2 [&>select]:min-w-0 [&>select]:max-w-full [&>select]:rounded-md [&>select]:border [&>select]:px-2 [&>select]:py-1 [&>button]:min-w-0 ${assetEditorExpanded ? "order-last shrink-0" : ""}`
            : "mt-3 flex gap-2"} style={compactStoryboardActions||(episodePlanning||assetPlanning)&&assetEditorExpanded?{borderColor:theme.node.stroke}:undefined}>
            {compactStoryboardActions && <Popover trigger="click" placement="topLeft"
                arrow={false} autoAdjustOverflow zIndex={1200}
                getPopupContainer={()=>document.body}
                open={scopeOpen} onOpenChange={setScopeOpen}
                styles={{content:{padding:0,background:theme.node.panel,borderRadius:12,
                    border:`1px solid ${theme.node.stroke}`,color:theme.node.text,
                    boxShadow:appearance==="dark"?"0 16px 38px rgba(0,0,0,.38)":"0 16px 38px rgba(0,0,0,.15)"}}}
                content={<div data-drama-storyboard-options="" aria-label="分镜生成范围设置"
                    className="thin-scrollbar max-h-[min(56vh,440px)] min-w-0 overflow-y-auto rounded-xl p-3"
                    style={{width:"min(430px,calc(100vw - 36px))",maxWidth:"100%",
                        borderColor:theme.node.stroke,background:theme.node.panel,
                        color:theme.node.text,colorScheme:appearance}}>
                    <div className="mb-3 space-y-1">
                        <strong className="text-sm font-semibold">生成范围设置</strong>
                        <p className="text-xs leading-relaxed" style={{color:theme.node.muted}}>
                            选择生成目标，仅影响下一次生成候选，不会修改当前镜头草案。
                        </p>
                    </div>
                    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                        <label className="grid min-w-0 gap-1 text-xs sm:col-span-2" style={{color:theme.node.muted}}>
                            剧集
                            <select className="h-9 w-full min-w-0 rounded-lg border px-2 text-xs" style={control}
                                aria-label="生成范围：剧集" disabled={videoEditing} value={selectedEpisode} onChange={event=>{
                                    if(!videoEditing){setSelectedEpisode(event.target.value);setSelectedSequence("");setSelectedRunShot("");}
                                }}>
                                <option value="" disabled>选择要生成的剧集</option>
                                {linkedEpisodes.map(episode=><option key={episode.id} value={episode.id}>{episode.title}</option>)}
                            </select>
                        </label>
                        {selectedEpisode && <>
                            <label className="grid min-w-0 gap-1 text-xs" style={{color:theme.node.muted}}>
                                场次
                                <select className="h-9 w-full min-w-0 rounded-lg border px-2 text-xs" style={control}
                                    aria-label="生成范围：场次" value={selectedSequence} onChange={event=>{
                                        setSelectedSequence(event.target.value);setSelectedRunShot("");
                                    }}>
                                    <option value="">全部场次</option>
                                    {scopeEpisode?.sequences?.map(sequence=>
                                        <option key={sequence.id} value={sequence.id}>{sequence.title}</option>)}
                                </select>
                            </label>
                            <label className="grid min-w-0 gap-1 text-xs" style={{color:theme.node.muted}}>
                                镜头
                                <select className="h-9 w-full min-w-0 rounded-lg border px-2 text-xs" style={control}
                                    aria-label="生成范围：镜头" value={selectedRunShot}
                                    onChange={event=>setSelectedRunShot(event.target.value)}>
                                    <option value="">全部镜头</option>
                                    {shots.filter(shot=>shot.episodeId===selectedEpisode&&
                                        (!selectedSequence||shot.sequenceId===selectedSequence))
                                        .map(shot=><option key={shot.id} value={shot.id}>镜头 {shot.order}</option>)}
                                </select>
                            </label>
                        </>}
                    </div>
                    {migrationPanel && <div className="mt-3 min-w-0 border-t pt-3" style={{borderColor:theme.node.stroke}}>
                        {migrationPanel}
                    </div>}
                </div>}>
                <Button size="middle" type="default" style={control} icon={<SlidersHorizontal size={14}/>}
                    aria-label="设置分镜生成范围" disabled={videoEditing} className="min-h-9 shrink-0">生成范围</Button>
            </Popover>}
            {compactStoryboardActions && <span data-drama-storyboard-scope-summary="" title={scopeLabel}
                className="hidden min-w-0 flex-1 truncate text-xs font-medium md:block"
                style={{color:theme.node.muted}}>{scopeLabel}</span>}
            {!inlineEditor && <Button onClick={() => { onChange({ dramaDraft: draft, ...(stage === "source" ? { content: draft } : {}) }); }}>保存草案</Button>}
            <Button size={inlineEditor && !assetEditorExpanded ? "small" : "middle"} className={compactStoryboardActions?"order-last shrink-0":inlineEditor?"order-last":undefined}
                style={inlineEditor && inlineReady && !generating ? dramaNodePrimary(theme) : undefined}
                type="primary" disabled={inlineEditor ? generating || assetEditing || videoEditing || !inlineReady || (versioned && versionBusy) : !draft.trim()} onClick={async () => {
                try {
                    if (stage === "assets" || stage === "episodes" || stage === "storyboard") {
                        const parsed: {assets?:unknown; episodes?:unknown; shots?:unknown} =
                            assetPlanning ? previous ?? {} : episodePlanning ? episodeDraft ?? {} : storyboardDraft ?? {};
                        const collection = stage === "assets" ? parsed.assets : stage === "episodes" ? parsed.episodes : parsed.shots;
                        if (!Array.isArray(collection) || (!assetPlanning && !collection.length)) throw Error("请确认有效的结构化 JSON 草案");
                        if (stage === "episodes" && collection.length !== targetEpisodes) throw Error(`剧集草案必须包含 ${targetEpisodes} 集`);
                        if (stage !== "episodes") {
                            const result = await canvasApi<{valid:boolean;errors:{code:string}[]}>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/drama-pipeline/validate`, "POST", {snapshot:parsedSnapshot});
                            if (!result.valid) throw Error(describeDramaValidation(result.errors, assets));
                        }
                    }
                    if (versioned && onConfirmVersion) {
                        await onConfirmVersion(draft);
                        report("confirm","success","版本已确认");
                        return;
                    }
                    const content = stage === "asset_references" ? JSON.stringify(parsedSnapshot, null, 2) :
                        assetPlanning ? JSON.stringify(previous) : episodePlanning ? JSON.stringify(episodeDraft) : draft;
                    setDraft(content); setConfirmed(content); report("confirm","success","版本已确认");
                    onChange({ dramaDraft: content, dramaConfirmed: content, dramaStage: stage,
                        ...(mergedEditing ? {dramaAssetReferences:referencesForDramaAssets(assets, storedReferences ?? [])} : {}),
                        ...(stage === "source" ? { content } : {}) });
                } catch (error) { reportError("confirm",error,"版本确认失败"); }
            }}>确认阶段</Button>
        <Button size={inlineEditor && !assetEditorExpanded ? "small" : "middle"}
            className={compactStoryboardActions?"ml-auto shrink-0":undefined} style={control} onClick={async () => {
            try {
                if (episodePlanning) {
                    if (episodeDraft?.episodes.length !== targetEpisodes) throw Error(`剧集草案必须包含 ${targetEpisodes} 集`);
                    report("validate","success","检查通过");
                    return;
                }
                if (!referenceEditing && (!previous || typeof previous !== "object" || Array.isArray(previous))) throw Error("请填写有效的结构化 JSON 草案");
                const result = await canvasApi<{valid:boolean;errors:{code:string}[]}>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/drama-pipeline/validate`, "POST", {snapshot:parsedSnapshot});
                if(result.valid)report("validate","success","检查通过");else report("validate","error","校验未通过，请检查草案内容",describeDramaValidation(result.errors,assets));
            } catch (error) { reportError("validate",error,"校验失败"); }
        }} disabled={!projectId || (inlineEditor && (!inlineReady || generating || assetEditing || videoEditing))}>{referenceEditing ? "校验主图" : assetPlanning ? "校验资产" : episodePlanning ? "校验剧集" : storyboard ? "校验分镜" : "校验结构化草案"}</Button>
        {assetPlanning&&workspaceMode&&<span className="mr-auto text-xs" style={{color:theme.node.muted}}>参考图已绑定 {references.filter(ref=>dramaReferenceImageKeys(ref).length>0).length} / {references.length} 个位置</span>}
        {assetPlanning && <select aria-label="资产提取范围" style={control} value={assetEpisode} onChange={event=>setAssetEpisode(event.target.value)}>
            <option value="">从完整故事提取</option>
            {supplementalEpisodes.map(episode=><option key={episode.id} value={episode.id}>补提 · {episode.title}</option>)}
        </select>}
        {episodePlanning && <select aria-label="剧集规划生成范围" style={control} value={selectedEpisode} onChange={event=>setSelectedEpisode(event.target.value)}>
            <option value="">完整剧集计划</option>
            {episodeDraft?.episodes.map(episode=><option key={episode.id} value={episode.id}>重跑 · {episode.title}</option>)}
        </select>}
        {!compactStoryboardActions&&<>
        {storyboard && <select aria-label="生成范围：剧集" disabled={videoEditing} value={selectedEpisode} onChange={event=>{
            if(!videoEditing){setSelectedEpisode(event.target.value);setSelectedSequence("");setSelectedRunShot("");}
        }}>
            <option value="" disabled>选择要生成的剧集</option>
            {linkedEpisodes.map(episode=><option key={episode.id} value={episode.id}>{episode.title}</option>)}
        </select>}
        {storyboard && selectedEpisode && <>
            <select aria-label="生成范围：场次" value={selectedSequence} onChange={event=>{
                setSelectedSequence(event.target.value);setSelectedRunShot("");
            }}>
                <option value="">全部场次</option>
                {linkedEpisodes.find(episode=>episode.id===selectedEpisode)?.sequences?.map(sequence=>
                    <option key={sequence.id} value={sequence.id}>{sequence.title}</option>)}
            </select>
            <select aria-label="生成范围：镜头" value={selectedRunShot} onChange={event=>setSelectedRunShot(event.target.value)}>
                <option value="">全部镜头</option>
                {shots.filter(shot=>shot.episodeId===selectedEpisode&&(!selectedSequence||shot.sequenceId===selectedSequence))
                    .map(shot=><option key={shot.id} value={shot.id}>镜头 {shot.order}</option>)}
            </select>
        </>}
        </>}
        {(stage === "assets" || stage === "episodes" || stage === "storyboard") ? <Button size={inlineEditor && !assetEditorExpanded ? "small" : "middle"} className={compactStoryboardActions?"shrink-0":undefined} style={control} loading={generating} onClick={async () => {
            const title=storyboard?"分镜候选":episodePlanning?"剧集候选":"资产候选";
            const target=storyboard?scopeLabel:episodePlanning?(episodeDraft?.episodes.find(item=>item.id===selectedEpisode)?.title||"完整剧集计划"):(supplementalEpisodes.find(item=>item.id===assetEpisode)?.title||"完整故事");
            if(generating)return;
            const task=feedbackApi?.beginTask("正在生成"+title,target);
            if(feedbackApi&&!task)return;
            feedbackApi?.clear("generate");
            setGenerating(true);
            try {
                const model = config.textModel;
                const channel = resolveModelChannel(config, model);
                const provider = modelChannelProvider(channel, "text");
                if (!channel || !provider || provider === "volcengine_ark") throw Error("请先在全局设置选择支持文本生成的模型渠道");
                const sourceText = String(node.metadata?.content ?? upstreamText);
                const baseContext = [upstreamContext || upstreamArtifacts.join("\n\n"), productionContext].filter(Boolean).join("\n\n");
                const context = assetPlanning && assetEpisode ? JSON.stringify({episode:supplementalEpisodes.find(item=>item.id===assetEpisode),existingAssets:previous?.assets??[]})+"仅补提选定剧集使用的资产。"+baseContext : stage === "storyboard" ? `${baseContext}\n\n已确认场景白名单：${JSON.stringify(scenes.map(scene => ({id:scene.id,name:scene.name,description:scene.description})))}。台阶、墙边等局部位置写入画面描述，sceneId 使用所属的已确认场景 ID。确实没有可引用场景时省略 sceneId。` : baseContext;
                if (stage === "storyboard" && storyboardGenerationBlock) throw Error(storyboardGenerationBlock);
                if (stage !== "storyboard" && !sourceText.trim()) throw Error("请先确认原文");
                task?.phase("准备模型渠道");
                await ensureSqliteModelChannelForExecution(channel, provider);
                if (storyboard||episodePlanning) {
                    task?.phase("保存当前草案");
                    await onBeforeDramaRun?.();
                    task?.phase("模型生成与校验");
                    const run=await canvasApi<DramaRun>(runPath,"POST",{requestId:crypto.randomUUID(),nodeId:node.id,
                        episodeId:selectedEpisode||"*",sequenceId:selectedSequence||undefined,shotId:selectedRunShot||undefined,
                        channelId:channel.id,provider,baseUrl:channel.baseUrl,model:modelOptionName(model)});
                    setRuns(current=>[run,...current.filter(item=>item.id!==run.id)]);
                    if(run.status==="ready"){
                        const count=storyboard?(run.candidate?.shots?.length??run.candidate?.shotCount):(run.candidate?.episodes?.length??run.candidate?.episodeCount);
                        report("generate","success",title+"生成成功"+(count===undefined?"":"，已生成 "+count+(storyboard?" 个镜头":" 集")));
                        if(workspaceMode){
                            if(feedbackApi)feedbackApi.focusRun(run.id);
                            else {setExpandedRuns({[run.id]:true});loadRunDetails(run);}
                            openCandidates?.();
                        }
                    }else if(run.status==="cancelled")report("generate","info","已取消生成");
                    else if(run.status==="failed"||run.status==="interrupted")reportError("run-action:"+run.id,run.error,title+dramaRunStatus(run.status));
                    else report("generate","info","运行状态："+dramaRunStatus(run.status));
                    return;
                }
                task?.phase("模型生成与校验");
                const result = await canvasApi<{answer:string}>(`/api/v1/projects/${encodeURIComponent(projectId ?? "")}/drama-pipeline/generate`, "POST", {
                    stage,
                    channelId: channel.id,
                    provider,
                    baseUrl: channel.baseUrl,
                    model: modelOptionName(model),
                    sourceText,
                    context,
                    targetEpisodes,
                });
                const assetDraft = assetPlanning ? readAssetDraft(result.answer) : undefined;
                const generatedEpisodes = episodePlanning ? readEpisodeDraft(result.answer) : undefined;
                if (assetPlanning && !assetDraft) throw Error("模型返回的资产格式有误，已保留原草案");
                if(assetPlanning&&assetDraft){
                    onChange({dramaAssetCandidate:{id:crypto.randomUUID(),baseline:storedDraft,assets:assetDraft.assets}});
                    report("generate","success",`已生成 ${assetDraft.assets.length} 项资产候选，等待审核`);
                    if(workspaceMode)openCandidates?.();
                    return;
                }
                if (episodePlanning && !generatedEpisodes?.episodes.length) throw Error("模型返回的剧集格式有误，已保留原草案");
                const generatedStoryboard = storyboard ? readStoryboardDraft(result.answer) : undefined;
                if (storyboard && !generatedStoryboard?.shots.length) throw Error("模型返回的分镜格式有误，已保留原草案");
                const structured = assetDraft ?? generatedEpisodes ?? generatedStoryboard;
                const answer = structured ? JSON.stringify(structured) : result.answer;
                setDraft(answer);
                report("generate","success","已生成草案，请检查并保存或确认");
                onChange({dramaDraft:answer});
            } catch (error) { reportError("generate",error,title+"生成失败"); }
            finally { task?.end();setGenerating(false); }
        }} title={storyboardGenerationBlock&&storyboard?storyboardGenerationBlock:undefined} disabled={!projectId || assetEditing || videoEditing || (versioned && versionBusy) || (storyboard && Boolean(storyboardGenerationBlock))}>{storyboard ? "生成分镜候选" : episodePlanning ? "生成剧集候选" : assetPlanning ? "生成资产候选" : "生成草案"}</Button> : null}
        </div>
        {storyboard&&storyboardGenerationBlock&&<p role="status" className="shrink-0 text-xs" style={{color:theme.node.muted}}>{storyboardGenerationBlock}</p>}
        {storyboard && !compactStoryboardActions && migrationPanel}
        </>}
        {(storyboard||episodePlanning) && (!workspaceMode || workspaceTab==="runs") && <>
         {workspaceMode&&<section data-drama-runs-panel="" aria-label="生成候选记录"
             className="min-w-0 shrink-0 space-y-2 rounded-xl border p-3"
             style={{background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text}}>
             <div className="flex flex-wrap items-center justify-between gap-2">
                 <div className="flex items-center gap-2">
                     <Sparkles size={17} aria-hidden="true" style={{color:theme.node.muted}}/>
                     <h3 className="text-sm font-semibold">生成候选记录</h3>
                 </div>
                 <span className="rounded-md border px-2 py-1 text-[11px] tabular-nums"
                   style={{borderColor:theme.node.stroke,color:theme.node.muted,background:theme.toolbar.activeBg}}>
                     共 {runs.length} 条 · 待采用 {runs.filter(run=>run.status==="ready").length} 条
                 </span>
             </div>
             <p className="text-xs leading-relaxed" style={{color:theme.node.muted}}>
                 仅查看候选不会覆盖现有草案。展开运行记录可预览候选、检查冲突并选择采用；记录在此页面打开期间自动刷新。
             </p>
             {runs.length===0&&<div role="status" className="rounded-lg border border-dashed px-4 py-8 text-center"
               style={{borderColor:theme.node.stroke,color:theme.node.muted}}>
                 暂无生成候选记录。返回剧集编辑页生成候选后，可在这里查看状态与结果。
             </div>}
         </section>}
         <div data-drama-run-scroll-region={workspaceMode?"":undefined}
            role={workspaceMode?"region":undefined} aria-label={workspaceMode?"生成候选列表":undefined}
            tabIndex={workspaceMode&&runs.length?0:undefined}
            className={workspaceMode?"thin-scrollbar min-h-0 min-w-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain pr-1 focus-visible:outline focus-visible:outline-1":"contents"}
            style={workspaceMode?{scrollbarColor:`${theme.node.code.scrollbar} transparent`,scrollbarGutter:"auto",outlineColor:theme.node.activeStroke}:undefined}>
         {runs.map(run=><details key={run.id}
            className="group min-w-0 shrink-0 rounded-xl border"
            style={{background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.text}}
            open={Boolean(expandedRuns[run.id])} onToggle={event=>{
            const open=event.currentTarget.open;
            if(Boolean(expandedRuns[run.id])===open)return;
            if(episodePlanning&&(candidateEditRef.current||candidateMutationRef.current)){event.currentTarget.open=Boolean(expandedRuns[run.id]);return;}
            setExpandedRuns(current=>({...current,[run.id]:open}));
            if(open)loadRunDetails(run);
        }}>
            <summary onClick={event=>{if(episodePlanning&&(candidateEditRef.current||candidateMutationRef.current))event.preventDefault();}} className="cursor-pointer list-none rounded-xl px-3 py-2.5 transition-colors hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline focus-visible:outline-1" style={{outlineColor:theme.node.activeStroke}}>
                <span className="flex w-full min-w-0 items-center gap-2" data-drama-run-summary-content>
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                      <ChevronRight size={14} aria-hidden="true" className="mr-1.5 inline-block align-text-bottom transition-transform group-open:rotate-90" style={{color:theme.node.muted}}/>
                      {run.episodeId==="*"?"完整剧集计划":(episodePlanning?episodeDraft?.episodes:linkedEpisodes)?.find(episode=>episode.id===run.episodeId)?.title ?? run.episodeId}
                    </span>
                    <span className="shrink-0 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium"
                        style={{borderColor:theme.node.stroke,background:theme.toolbar.activeBg,color:theme.node.text}}>
                        {dramaRunStatus(run.status)}{episodePlanning&&run.status==="ready"&&candidateRevision(run)>0?" · 已修改":""}
                    </span>
                </span>
            </summary>
            <div className="min-w-0 space-y-3 break-words border-t p-3 [overflow-wrap:anywhere]" style={{borderColor:theme.node.stroke}}>
            {run.error && <DramaInlineFeedback theme={theme} level="error" error={run.error}/>}
            {!!run.candidate?.completedSequenceIds?.length && <p>已保存 {run.candidate.completedSequenceIds.length} 个场次，重试将继续未完成场次。</p>}
            {(run.status==="running"||["failed","interrupted","cancelled"].includes(run.status)) &&
                <Button size="small" style={control} disabled={run.status==="running"?cancelBusyIds.includes(run.id):runActionBusy||Boolean(feedback?.task)||Boolean(candidateEdit)||candidateMutationBusy} onClick={()=>{
                    const action=run.status==="running"?"cancel":"retry";
                    const execute=async()=>{
                    try{
                        const result=await canvasApi<DramaRun>(`${runPath}/${encodeURIComponent(run.id)}/${action}`,"POST",{});
                        setRuns(current=>current.map(item=>item.id===run.id?result:item));
                        if(result.status==="ready"){setExpandedRuns({[result.id]:true});loadRunDetails(result);report("run-action:"+run.id,"success","候选已就绪，等待审核");}
                        else if(result.status==="failed"||result.status==="interrupted")reportError("run-action:"+run.id,result.error,"候选"+dramaRunStatus(result.status));
                        else report("run-action:"+run.id,"info","候选状态："+dramaRunStatus(result.status));
                    }catch(error){reportError("run-action:"+run.id,error,"运行操作失败");}
                    };
                    if(action==="retry"){void runAction("正在重试候选生成",execute);return;}
                    if(cancelFlights.current.has(run.id))return;
                    cancelFlights.current.add(run.id);setCancelBusyIds([...cancelFlights.current]);
                    void execute().finally(()=>{cancelFlights.current.delete(run.id);setCancelBusyIds([...cancelFlights.current]);});
                }}>{run.status==="running"?"取消生成":"使用原输入重试"}</Button>}
            {episodePlanning&&expandedRuns[run.id]&&<DramaEpisodeCandidates run={run} projectId={projectId} theme={theme}
                disabled={!workspaceMode||runActionBusy||candidateMutationBusy||Boolean(feedback?.task)||Boolean(candidateEdit&&candidateEdit.runId!==run.id)}
                activeKey={candidateEdit?.runId===run.id?candidateEdit.key:null} onEditingChange={changeCandidateEditing}
                onPendingChange={onPendingChange} onPatch={(target,id,changes)=>changeCandidate(target,"PATCH",id,changes)}
                onWholePatch={(target,id,changes)=>changeCandidate(target,"PATCH",id,changes,true)}
                onRemove={(target,id)=>changeCandidate(target,"DELETE",id)}
                onDiscard={target=>changeCandidate(target,"DELETE")} onReload={()=>readEpisodeRunDetails(run,true)} onConfirmingChange={changeCandidateConfirming}/>}

             {storyboard&&runPreviews[run.id]&&<div className="grid gap-3 rounded-lg border p-3" style={{borderColor:theme.node.stroke,background:theme.node.fill}} aria-label="分镜候选差异预览">
                 <p>差异：新增 {runPreviews[run.id].summary.added} · 替换 {runPreviews[run.id].summary.replaced}
                     · 删除 {runPreviews[run.id].summary.deleted} · 重排 {runPreviews[run.id].summary.reordered}
                     · 无变化 {runPreviews[run.id].summary.unchanged}</p>
                 {runPreviews[run.id].sourceChanged&&<DramaInlineFeedback theme={theme}>确认的上游输入已变化，请重新生成候选。</DramaInlineFeedback>}
                 <Button size="small" style={control} disabled={runActionBusy} onClick={async()=>{
                     try{
                         const preview=await canvasApi<DramaRunPreview>(`${runPath}/${encodeURIComponent(run.id)}/preview`,"GET");
                         setRunPreviews(current=>({...current,[run.id]:preview}));
                         setSelectedCandidates(current=>({...current,[run.id]:(current[run.id]??[]).filter(id=>
                             !preview.sourceChanged&&preview.items.some(item=>
                                 item.id===id&&item.changed&&!item.conflict&&!item.adopted))}));
                         report("run-preview:"+run.id,"success","已刷新差异与冲突状态");
                     }catch(error){reportError("run-preview:"+run.id,error,"无法刷新差异预览");}
                 }}>刷新差异与冲突</Button>
                 {!!runPreviews[run.id].manualExtraIds.length&&<DramaInlineFeedback theme={theme}>
                     模型运行期间新增了人工镜头（{runPreviews[run.id].manualExtraIds.join("、")}）。整批采用已禁用；可单独采用无冲突候选。
                 </DramaInlineFeedback>}
                 {run.status==="ready"&&<Button size="small" style={control} disabled={runActionBusy||runPreviews[run.id].sourceChanged||
                     !runPreviews[run.id].items.some(item=>item.changed&&!item.conflict&&!item.adopted)}
                     onClick={()=>setSelectedCandidates(current=>({...current,[run.id]:
                         runPreviews[run.id].items.filter(item=>item.changed&&!item.conflict&&!item.adopted).map(item=>item.id)}))}>
                     选择全部无冲突差异
                 </Button>}
                 {runPreviews[run.id].items.map(item=><label key={item.id} className="grid gap-1 rounded-lg border p-3" style={{borderColor:theme.node.stroke,background:theme.node.panel}}>
                     <span className="flex items-center gap-2">
                         {run.status==="ready"&&item.changed&&<input type="checkbox" aria-label={`选择差异 ${item.id}`}
                             checked={(selectedCandidates[run.id]??[]).includes(item.id)}
                             disabled={runActionBusy||item.conflict||item.adopted||runPreviews[run.id].sourceChanged}
                             onChange={event=>setSelectedCandidates(current=>({...current,[run.id]:event.target.checked?
                                 [...new Set([...(current[run.id]??[]),item.id])]:
                                 (current[run.id]??[]).filter(id=>id!==item.id)}))}/>}
                         <strong>{item.kind==="added"?"新增":item.kind==="deleted"?"删除":
                             item.kind==="reordered"?"重排":item.kind==="replaced"?"替换":"无变化"}</strong>
                         <span>{item.id}</span>
                         {item.adopted&&<span>已采用</span>}
                         {item.conflict&&<span role="alert">人工编辑冲突，暂不可采用</span>}
                         {item.reordered&&item.kind!=="reordered"&&<span>含顺序调整</span>}
                     </span>
                     {item.before&&<p className="break-words opacity-75">原镜头 {item.before.order}：{item.before.description}</p>}
                     {item.after&&<p className="break-words">候选镜头 {item.after.order}：{item.after.description}</p>}
                 </label>)}
             </div>}
             {storyboard&&["ready","adopted"].includes(run.status)&&!runPreviews[run.id]&&<div><DramaInlineFeedback theme={theme} level="info">请先加载最新差异预览，再选择采用。</DramaInlineFeedback><Button size="small" style={control} disabled={runActionBusy} onClick={()=>loadRunDetails(run)}>重新加载差异预览</Button></div>}
             {storyboard&&run.status==="ready"&&<Button size="small" style={control} disabled={runActionBusy||Boolean(feedback?.task)||!onAdoptDramaRun||!runPreviews[run.id]||
                 !selectedCandidates[run.id]?.length||runPreviews[run.id].sourceChanged||
                 selectedCandidates[run.id]?.some(id=>!runPreviews[run.id].items.some(item=>
                     item.id===id&&item.changed&&!item.conflict&&!item.adopted))} onClick={()=>void runAction("正在合入所选分镜差异",async()=>{
                 try{
                     if(!onAdoptDramaRun)throw Error("候选采用服务未连接");
                     await onAdoptDramaRun(`${runPath}/${encodeURIComponent(run.id)}/adopt`,selectedCandidates[run.id]);
                 }catch(error){reportError("adopt-run:"+run.id,error,"候选采用失败，请刷新差异预览");return;}
                 setSelectedCandidates(current=>({...current,[run.id]:[]}));
                 setRunPreviews(current=>{const next={...current};delete next[run.id];return next;});
                 report("adopt-run:"+run.id,"success","已合入所选差异，其他候选仍保留");
                 try{
                     const updated=await canvasApi<DramaRun>(`${runPath}/${encodeURIComponent(run.id)}`,"GET");
                     const preview=await canvasApi<DramaRunPreview>(`${runPath}/${encodeURIComponent(run.id)}/preview`,"GET");
                     setRuns(current=>current.map(item=>item.id===run.id?updated:item));
                     setRunPreviews(current=>({...current,[run.id]:preview}));feedbackApi?.clear("run-preview:"+run.id);
                 }catch(error){reportError("run-preview:"+run.id,error,"差异已合入，刷新结果失败，请重新加载预览");}
             })}>采用所选差异</Button>}
             {episodePlanning&&run.status==="ready"&&expandedRuns[run.id]&&<DramaEpisodeAdoptionReview
                 key={run.id+":"+candidateRevision(run)} runId={run.id} revision={candidateRevision(run)} path={`${runPath}/${encodeURIComponent(run.id)}`} theme={theme}
                 disabled={!workspaceMode||runActionBusy||Boolean(feedback?.task)||!onAdoptDramaRun||Boolean(candidateEdit)||candidateMutationBusy||candidateConfirmations.includes(run.id)||!hasEpisodeDetails(run)}
                 onAdopt={async review=>{
                     if(!onAdoptDramaRun||runActionRef.current||candidateMutationRef.current||candidateEditRef.current)throw Error("请等待当前操作完成");
                     const task=feedbackApi?.beginTask("正在合入剧集候选",undefined,true);
                     if(feedbackApi&&!task)throw Error("请等待当前操作完成");
                     candidateMutationRef.current=true;candidateReadEpoch.current++;setCandidateMutationBusy(true);
                     try{
                         await onAdoptDramaRun(`${runPath}/${encodeURIComponent(run.id)}/adopt`,undefined,candidateRevision(run),review);
                         setRuns(current=>current.map(item=>item.id===run.id?{...item,status:"adopted"}:item));
                         report("adopt-run:"+run.id,"success","已合入候选草案，请检查后确认版本");
                         try{
                             const updated=await canvasApi<DramaRun>(`${runPath}/${encodeURIComponent(run.id)}`,"GET");
                             if(updated.status==="adopted")setRuns(current=>current.map(item=>item.id===run.id?updated:item));
                         }catch(error){reportError("run-detail:"+run.id,error,"候选已采用，刷新记录失败");}
                     }catch(error){reportError("adopt-run:"+run.id,error,"候选采用失败，请刷新差异预览");throw error;}
                     finally{candidateReadEpoch.current++;candidateMutationRef.current=false;setCandidateMutationBusy(false);task?.end();}
                 }}/>}
             {!episodePlanning&&run.status==="ready" && <Button size="small" style={dramaNodePrimary(theme)} disabled={runActionBusy||Boolean(feedback?.task)||!onAdoptDramaRun||episodePlanning&&(Boolean(candidateEdit)||candidateMutationBusy||candidateConfirmations.includes(run.id)||!hasEpisodeDetails(run))||storyboard&&(!runPreviews[run.id]||
                 runPreviews[run.id].fullAdoptBlocked)} onClick={()=>void runAction("正在合入候选草案",async()=>{
                 try{
                     if(!onAdoptDramaRun)throw Error("候选采用服务未连接");
                     await onAdoptDramaRun(`${runPath}/${encodeURIComponent(run.id)}/adopt`);
                     setRuns(current=>current.map(item=>item.id===run.id?{...item,status:"adopted"}:item));
                     report("adopt-run:"+run.id,"success","已合入候选草案，请检查后确认版本");
                 }catch(error){reportError("adopt-run:"+run.id,error,"候选采用失败，请刷新差异预览");return;}
                 if(storyboard){
                     setRunPreviews(current=>{const next={...current};delete next[run.id];return next;});
                     try{const preview=await canvasApi<DramaRunPreview>(`${runPath}/${encodeURIComponent(run.id)}/preview`,"GET");
                         setRunPreviews(current=>({...current,[run.id]:preview}));feedbackApi?.clear("run-preview:"+run.id);
                     }catch(error){reportError("run-preview:"+run.id,error,"候选已合入，刷新差异失败，请重新加载预览");}
                 }
             })}>采用到草案</Button>}
            </div>
         </details>)}
         </div>
         </>}
        {!feedbackApi && validation ? <p role="status" className={`mt-2 whitespace-pre-wrap text-sm ${assetEditorExpanded ? "thin-scrollbar max-h-24 shrink-0 overflow-y-auto" : ""}`}>{validation}</p> : null}
        {invalidSceneIds.map(id => <label className="mt-2 block text-sm" key={id}>
            将所有引用 {id} 的镜头改为
            <select className="ml-2" value="" onChange={event => {
                if (event.target.value) replaceScene(id, event.target.value);
            }}>
                <option value="">选择已确认场景</option>
                {scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.name}（{scene.id}）</option>)}
            </select>
        </label>)}
        {confirmed && !inlineEditor ? <details className="mt-3"><summary>已确认内容</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{confirmed}</pre></details> : null}
        </div>
    </section>;
    if (workspaceMode || !inlineEditor || !assetEditorExpanded) return editor;
    return <>
        <div className="flex h-full items-center justify-center text-xs" style={{color:theme.node.text}}>正在大面板中编辑</div>
        <Modal open centered title={<span style={{color:theme.node.text}}>{DRAMA_PIPELINE_STAGE_LABELS[stage]}</span>} width="min(1280px, calc(100vw - 32px))"
            footer={null} onCancel={() => setAssetEditorExpanded(false)}
            styles={{
                container:{background:theme.node.fill},
                header:{background:theme.node.fill},
                body:{height:"min(880px, calc(100dvh - 128px))", overflow:"hidden", padding:"12px 4px 16px"},
            }}>
            {editor}
        </Modal>
    </>;
}