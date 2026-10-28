import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Group, Video } from "lucide-react";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { MissingSkillVersionError, resolveManualSkillContext, withManualSkillMessages, type ManualSkillContext } from "@/features/skills/skill-manual";
import { prepareAutomaticSkillCatalog, withAutomaticSkillCatalog, isUnsupportedSkillToolsError, type AutomaticSkillPlan } from "@/features/skills/skill-auto";
import { isSkillToolsKnownUnsupported, rememberSupportedSkillTools, rememberUnsupportedSkillTools } from "@/features/skills/skill-tool-capability";
import { extractSkillMentions, resolvePromptSkillBinding, showLegacySkillMentions } from "@/features/skills/skill-mentions";
import { requestAudioGeneration } from "@/services/api/audio";
import { requestVideoGeneration, type VideoGenerationRequest, type VideoGenerationTask } from "@/services/api/video";
import { defaultConfig, resolveModelChannel, resolveModelScript, modelOptionName, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import {recoverLegacyGeneratedImageSize} from "@/lib/canvas/canvas-generated-image-size";
import {recoverLegacyGeneratedVideoSize} from "@/lib/canvas/canvas-generated-video-size";
import { deleteStoredImages,getImageBlob } from "@/services/image-storage";
import { deleteStoredMedia,getMediaBlob } from "@/services/file-storage";
import {uploadCanvasImage as uploadImage,uploadCanvasMedia,storeCanvasGeneratedVideo as storeGeneratedVideo,storeCanvasGeneratedAudio as storeGeneratedAudio,isCanvasCasKey,canvasCasUrl} from "@/features/backend-sync/canvas-media";
const uploadMediaFile=(input:string|Blob,prefix="video")=>uploadCanvasMedia(input,prefix==="audio"?"audio":"video");
import { setPreviewGenerationSuspended } from "@/services/media-preview-storage";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { awaitAssetStorePersistence, useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cullConnections, worldViewRect } from "@/lib/canvas/canvas-connection-culling";
import { reuseCanvasVisibleList } from "@/lib/canvas/canvas-visible-list";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { focusSelectionViewport, isFocusSelectionBlocked, isFocusSelectionKey } from "@/lib/canvas/canvas-focus-selection";
import { App, Button, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionOverlay, ConnectionLayer } from "@/components/canvas/canvas-connection-layer";
import { CanvasActionsProvider, type CanvasActions } from "@/components/canvas/canvas-actions";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasGraphIndexProvider } from "@/components/canvas/canvas-graph-context";
import { CanvasPerfBridge } from "@/components/canvas/canvas-perf-bridge";
import { pipelineSink } from "@/lib/canvas/canvas-perf-bridge-state";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasVideoFrameDialog } from "@/components/canvas/canvas-video-frame-dialog";
import { CanvasAudioTrimDialog } from "@/components/canvas/canvas-audio-trim-dialog";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { buildNodeGenerationContext, buildNodeResponseMessages, hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { AtelierCanvas } from "@/components/canvas/atelier-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { NodeLayer, type SharedNodeProps } from "@/components/canvas/canvas-node-layer";
import { SelectionOverlay } from "@/components/canvas/canvas-selection-overlay";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { DirectorPanel } from "@/components/canvas/director-panel";
import { flushCanvasStorePersistence,awaitCanvasStorePersistence,useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { registerCanvasBackupFlush } from "@/services/canvas-backup-sync";
import { useGenerationHistoryStore, type GenerationHistoryImage } from "@/stores/canvas/use-generation-history-store";
import { buildCanvasGraphIndex } from "@/lib/canvas/canvas-graph-index";
import { prepareCanvasPortConnection, reconcileComfyArtifactConnections } from "@/lib/canvas/canvas-port-connections";
import { pickCanvasDropHandle } from "@/lib/canvas/canvas-ports";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { findContainingGroupId, findGroupDropTarget, findGroupDropTargetFromDelta, fitViewportToNodes, getConnectionTargetAnchor, groupSelectedCanvasNodes, normalizeConnection, normalizeConnectionFromIndex, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import {
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    findRetrySourceNode,
    generationReferenceUrls,
    getGenerationCount,
    hydrateAssistantImages,
    hydrateCanvasImages,
    imageExtension,
    isAudioFile,
    isGenerationCanceled,
    resetInterruptedGeneration,
    resolveMetadataReferences,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType } from "@/lib/canvas/node-registry";
import { assertSeedanceTextModeReferences, resolveSeedanceInputAssignments } from "@/lib/canvas/seedance-input-assignments";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
const ComfyWorkflowInstancePanel = lazy(() => import("@/features/comfy-workflow/comfy-workflow-instance-panel").then((m) => ({default:m.ComfyWorkflowInstancePanel})));
import { COMFY_WORKFLOW_MOCK_TYPE } from "@/lib/canvas/canvas-ports";
import { validateCanvasPortConnections } from "@/lib/canvas/canvas-port-connections";
import type {ComfyRunState} from "@/features/comfy-workflow/run-types";
import { getComfyTemplate } from "@/features/comfy-workflow/template-registry";
import { resolveCanvasComfyInstance } from "@/features/comfy-workflow/canvas-instance";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { startBackendComfyWorkflowRun } from "@/features/backend-sync/backend-comfy-run";
import {createSqliteComfyBridge} from "@/features/backend-sync/sqlite-comfy-bridge";
import {startSqliteModelGeneration,openAiImageSize} from "@/features/backend-sync/sqlite-model-generation";
import {findSqliteModelRetrySource} from "@/features/backend-sync/sqlite-model-retry-source";
import {freezeSqliteSkillCatalog,type FrozenSqliteSkillCatalog} from "@/features/backend-sync/frozen-sqlite-skills";
import {freezeSeedanceReferences} from "@/features/backend-sync/seedance-frozen-references";
import {capabilitiesForModel} from "@/services/api/video/model-capabilities";
import {validateSeedanceRequest} from "@/services/api/video/seedance-content";
import {ensureSqliteModelChannelForExecution,modelChannelProvider} from "@/features/backend-sync/model-channel-autoroute";
import {watchSqliteComfyJob} from "@/features/backend-sync/sqlite-comfy-job-watch";
import {refreshSqliteComfyArtifacts} from "@/features/backend-sync/sqlite-comfy-job-watch";
import {CanvasJobHistory} from "@/features/backend-sync/canvas-job-history";
import {canvasApi} from "@/features/backend-sync/canvas-api";
import {preserveValidCanvasViewport} from "@/features/backend-sync/canvas-state-persistence";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeImage,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";
import type { ReferenceVideo } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    nodeId: string | null;
    handle: ConnectionHandle | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    comfyInstanceId?: string;
};

function sameCanvasHistoryEntry(left: CanvasHistoryEntry | null, right: CanvasHistoryEntry) {
    return Boolean(left && left.nodes === right.nodes && left.connections === right.connections && left.chatSessions === right.chatSessions && left.activeChatId === right.activeChatId && left.backgroundMode === right.backgroundMode && left.showImageInfo === right.showImageInfo && left.comfyInstanceId === right.comfyInstanceId);
}

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
// Screen pixels of slack around the viewport when culling connections. An edge is then drawn
// slightly before it scrolls in, so the cull boundary does not flicker. Divided by viewport.k to
// become world units.
const CONNECTION_CULL_MARGIN = 64;
// Spelled out inline so Vite inlines it before Rollup runs, making every guarded branch provably
// dead in a normal build — the timing probes below must not exist outside a perf build.
const CANVAS_PERF_MODE = import.meta.env.MODE === "perf";
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

function isNativeArkVideo(config: typeof defaultConfig, modelOption: string) {
    return resolveModelChannel(config, modelOption)?.apiFormat === "volcengine_ark" && !resolveModelScript(config, modelOption);
}

function isResumableSeedanceProvider(provider?: string): provider is "volcengine_ark" | "router_local" {
    return provider === "volcengine_ark" || provider === "router_local";
}

function makeVideoGenerationRequest(config: typeof defaultConfig, prompt: string, modelOption: string, context: { referenceImages: ReferenceImage[]; referenceVideos: ReferenceVideo[]; referenceAudios: ReferenceAudio[] }, assignments?: CanvasNodeMetadata["videoReferences"], requireArkAssignments = isNativeArkVideo(config, modelOption)): VideoGenerationRequest {
    const mode = config.videoMode || "text_to_video";
    let references: VideoGenerationRequest["references"] = [
        ...context.referenceImages.map((item) => ({ id: item.id, kind: "image" as const, role: "reference_image" as const, dataUrl: item.dataUrl, storageKey: item.storageKey, mimeType: item.type, width: item.width, height: item.height })),
        ...context.referenceVideos.map((item) => ({ id: item.id, kind: "video" as const, role: "reference_video" as const, url: item.url, storageKey: item.storageKey, mimeType: item.type, bytes: item.bytes, durationMs: item.durationMs, width: item.width, height: item.height })),
        ...context.referenceAudios.map((item) => ({ id: item.id, kind: "audio" as const, role: "reference_audio" as const, url: item.url, storageKey: item.storageKey, mimeType: item.type, durationMs: item.durationMs, bytes: item.bytes })),
    ];
    if (requireArkAssignments) {
        if (mode === "text_to_video") assertSeedanceTextModeReferences(references, assignments);
        const byId = new Map(references.map((item) => [item.id, item]));
        references = resolveSeedanceInputAssignments(mode, references, assignments).flatMap((assignment) => {
            const input = byId.get(assignment.id);
            return input && assignment.role ? [{ ...input, role: assignment.role }] : [];
        });
    }
    return {
        modelOption,
        mode,
        prompt,
        references,
        durationSeconds: Number(config.videoSeconds) === -1 ? -1 : Number(config.videoSeconds) || 6,
        resolution: (config.vquality === "4k" ? "4k" : `${(config.vquality || "720").replace(/p$/i, "")}p`) as VideoGenerationRequest["resolution"],
        ratio: (config.videoRatio || "adaptive") as VideoGenerationRequest["ratio"],
        generateAudio: config.videoGenerateAudio !== "false",
        watermark: config.videoWatermark === "true",
        returnLastFrame: config.videoReturnLastFrame === "true",
    };
}

async function saveArkLastFrame(blob: Blob) {
    const image = await uploadImage(blob);
    return { storageKey: image.storageKey, url: image.url, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
}
export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <AtelierCanvasPage />;
}

function AtelierCanvasPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const projectId = params.id || "";
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    // Marquee coalescing: pointermove only records the latest position, and one frame does the
    // intersect pass plus at most one selection update.
    const marqueeRafRef = useRef<number | null>(null);
    const marqueePointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const marqueeSelectionRef = useRef<Set<string> | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        /** A video cover click starts playback without opening the node inspector. */
        suppressClickPanel: boolean;
        // Map, not an array: the per-frame update needs O(1) lookup per node, and the previous
        // `initialPositions.find(...)` inside the node loop was O(N x M) every frame.
        initialPositions: Map<string, { x: number; y: number }>;
        // Snapshotted at drag start so the frame loop never rebuilds or rescans the whole node list.
        movedNodes: CanvasNodeData[];
        reversedCandidateGroups: CanvasNodeData[];
        latestDelta: { dx: number; dy: number };
        lastDropTargetId: string | null;
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        suppressClickPanel: false,
        initialPositions: new Map(),
        movedNodes: [],
        reversedCandidateGroups: [],
        latestDelta: { dx: 0, dy: 0 },
        lastDropTargetId: null,
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const globalComfyInstanceId = useConfigStore((state) => state.config.comfyInstanceId);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const loadProjects = useCanvasStore((state) => state.loadProjects);
    const loadProject = useCanvasStore((state) => state.loadProject);
    const backendSaveError=useCanvasStore((state)=>state.error);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    // Select only the title, never the project object: `updateProject` builds a fresh project object
    // on every patch, and the persistence effect patches on every `nodes` change — i.e. every drag
    // frame. Selecting the object made this whole page render a second time per frame.
    const currentProjectTitle = useCanvasStore((state) => state.projects.find((project) => project.id === projectId)?.title);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [isWheelZooming, setIsWheelZooming] = useState(false);
    const [isCanvasPanning, setIsCanvasPanning] = useState(false);
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("pan");
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [jobHistoryOpen,setJobHistoryOpen]=useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [comfyInstanceId, setComfyInstanceId] = useState<string | undefined>(undefined);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [projectLoadError,setProjectLoadError]=useState<string|null>(null);
    const [projectLoadAttempt,setProjectLoadAttempt]=useState(0);
    const [backendComfyEnabled,setBackendComfyEnabled] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [videoFrameNodeId, setVideoFrameNodeId] = useState<string | null>(null);
    const videoFrameIdentityRef = useRef<string | null>(null);
    const [audioTrimNodeId, setAudioTrimNodeId] = useState<string | null>(null);
    const audioTrimIdentityRef = useRef<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [previewImageId, setPreviewImageId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [expandedImageNodeIds, setExpandedImageNodeIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
    const editingGestureActive = isNodeDragging || isNodeResizing || selectionBox !== null;
    useEffect(() => {
        setPreviewGenerationSuspended(editingGestureActive, "canvas-edit");
        return () => setPreviewGenerationSuspended(false, "canvas-edit");
    }, [editingGestureActive]);

    const nodesRef = useRef(nodes);
    const activeProjectIdRef = useRef(projectId);
    const pageMountedRef = useRef(true);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    useEffect(() => {
        pageMountedRef.current = true;
        return () => { pageMountedRef.current = false; };
    }, []);
    const viewportRef = useRef(viewport);
    // One adjacency index per graph revision. Everything that used to scan `nodes`/`connections`
    // per item (id lookups, group children, resource references, generation inputs) reads from it.
    // Declared before the effects below so they can mirror it for the window-level gesture handlers.
    const graphIndex = useMemo(() => {
        if (!CANVAS_PERF_MODE) return buildCanvasGraphIndex(nodes, connections);
        const started = performance.now();
        const built = buildCanvasGraphIndex(nodes, connections);
        pipelineSink.addMs("graphIndexMs", performance.now() - started);
        pipelineSink.count("graphIndexNodes", nodes.length);
        return built;
    }, [nodes, connections]);
    const graphIndexRef = useRef(graphIndex);
    const directorPanelNode = dialogNodeId && graphIndex.nodeById.get(dialogNodeId)?.type === CanvasNodeType.Director ? graphIndex.nodeById.get(dialogNodeId) : undefined;
    // Container rect cache. Screen-to-world conversion runs on every pointermove during drag,
    // marquee and connect-drag; measuring the container there forces a synchronous layout each
    // time. Kept fresh by the ResizeObserver effect and nulled on scroll (see that effect).
    const containerRectRef = useRef<DOMRect | null>(null);
    const viewportAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const comfyExecuteLocksRef = useRef(new Set<string>());
    const sqliteJobWatchesRef=useRef(new Map<string,AbortController>());
    const monitorSqliteJobRef=useRef<(jobId:string)=>void>(()=>{});
    const sqliteGenerationJobsRef=useRef(new Map<string,string>());
    const sqliteModelSubmitLocksRef=useRef(new Set<string>());

    const persistVideoTask = useCallback((nodeId: string, task: VideoGenerationTask, status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired" = task.status || "queued") => {
        const nodesWithTask = nodesRef.current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, videoTask: { provider: task.provider, channelId: task.channelId, model: task.model, taskId: task.id, startedAt: task.startedAt || Date.now(), status } } } : node);
        nodesRef.current = nodesWithTask;
        setNodes(nodesWithTask);
        updateProject(projectId, { nodes: nodesWithTask });
        flushCanvasStorePersistence();
    }, [projectId, updateProject]);

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
            comfyInstanceId,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo, comfyInstanceId],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const stopGenerationByRunningId = useCallback(
        (runningId: string) => {
            const affectedNodeIds = new Set<string>();
            generationRequestsRef.current.forEach((request) => {
                if (request.runningNodeId !== runningId) return;
                request.controller.abort();
                generationRequestsRef.current.delete(request.targetNodeId);
                affectedNodeIds.add(request.targetNodeId);
                affectedNodeIds.add(request.originNodeId);
            });
            setRunningNodeId((current) => (current === runningId ? null : current));
            if (!affectedNodeIds.size) return;
            setNodes((prev) =>
                prev.map((node) =>
                    affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  status: NODE_STATUS_IDLE,
                                  errorDetails: undefined,
                                  images: node.metadata.images?.map((image) => (image.status === NODE_STATUS_LOADING ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : image)),
                              },
                          }
                        : node,
                ),
            );
        },
        [t],
    );

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: t("canvas.projectPage.stopTitle"),
                content: t("canvas.projectPage.stopDescription"),
                okText: t("canvas.projectPage.stop"),
                cancelText: t("canvas.projectPage.continue"),
                okButtonProps: { danger: true },
                onOk: async () => {
                    const jobId=sqliteGenerationJobsRef.current.get(nodeId);
                    if(!jobId){stopGenerationByRunningId(nodeId);return}
                    try{
                        const result=await canvasApi<{cancelled:boolean;reason?:string}>(
                          "/api/v1/jobs/"+encodeURIComponent(jobId)+"/cancel","POST",{});
                        if(result.cancelled){
                            sqliteGenerationJobsRef.current.delete(nodeId);
                            setRunningNodeId(current=>current===nodeId?null:current);
                            message.success("任务已取消");
                        }else{
                            message.warning("无法取消已开始生成的云端任务："+(result.reason||"not_queued"));
                        }
                    }catch(error){message.error(error instanceof Error?error.message:String(error))}
                },
            });
        },
        [modal, stopGenerationByRunningId, t, message],
    );


    // SQLite-only: connect in the background, never ask the user to sync.
    useEffect(()=>{if(!hydrated)void loadProjects().catch(()=>{});},[hydrated,loadProjects]);

    // Manual opt-in. Legacy local project remains authoritative until the
    // user connects and the backend's saved graph baseline matches.


    // SQLite-only Canvas: execution capability is discovered automatically.
    // No manual sync connection and no separate browser project revision.
    useEffect(()=>{
        if(!projectLoaded||!globalComfyInstanceId){setBackendComfyEnabled(false);return}
        let cancelled=false;
        const refresh=()=>void canvasApi<{autoDispatch:boolean;comfyInstanceIds:string[]}>(
            "/api/v1/execution/capabilities"
        ).then(capability=>{
            if(!cancelled)setBackendComfyEnabled(Boolean(
                capability.autoDispatch&&capability.comfyInstanceIds.includes(globalComfyInstanceId)
            ));
        }).catch(()=>{if(!cancelled)setBackendComfyEnabled(false)});
        refresh();
        window.addEventListener("atelier:comfy-instances-changed",refresh);
        window.addEventListener("focus",refresh);
        return ()=>{
            cancelled=true;
            window.removeEventListener("atelier:comfy-instances-changed",refresh);
            window.removeEventListener("focus",refresh);
        };
    },[projectLoaded,globalComfyInstanceId]);

    useEffect(()=>()=>{for(const watch of sqliteJobWatchesRef.current.values())watch.abort();
        sqliteJobWatchesRef.current.clear()},[projectId]);

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        nodesRef.current = [];
        setProjectLoadError(null);
        connectionsRef.current = [];
        const restore = async () => {
            let project;
            try{project=await loadProject(projectId)}
            catch(error){
                if(!cancelled)setProjectLoadError(String(error));
                return; // Backend is mandatory; never load origin-local projects.
            }
            if(cancelled)return;
            const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(project.nodes));
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            if (cancelled) return;
            const restoredConnections=reconcileComfyArtifactConnections(restoredNodes,project.connections,nanoid);
            nodesRef.current = restoredNodes;
            connectionsRef.current = restoredConnections;
            setNodes(restoredNodes);
            setConnections(restoredConnections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setComfyInstanceId(resolveCanvasComfyInstance(project));
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: restoredConnections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
                comfyInstanceId: project.comfyInstanceId,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
        };
        void restore();
        let cancelled = false;
        return () => { cancelled = true; };
    }, [hydrated, loadProject, projectId,projectLoadAttempt]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (sameCanvasHistoryEntry(previous, next)) return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo, comfyInstanceId]);

    // Independent persistence lanes: typing into chat must not write a 200-node
    // graph, and viewport movement must never advance the graph revision.
    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { nodes, connections, backgroundMode, showImageInfo, comfyInstanceId });
    }, [backgroundMode, connections, nodes, projectId, projectLoaded, showImageInfo, comfyInstanceId, updateProject]);
    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { chatSessions, activeChatId });
    }, [activeChatId, chatSessions, projectId, projectLoaded, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    // Settings backup must include local edits and the viewport before debounce fires.
    useEffect(() => {
        if (!projectLoaded) return;
        return registerCanvasBackupFlush(() => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
            viewportSaveTimerRef.current = null;
            updateProject(projectId, {
                nodes: nodesRef.current,
                connections: connectionsRef.current,
                chatSessions,
                activeChatId,
                backgroundMode,
                showImageInfo,
                comfyInstanceId,
                viewport: viewportRef.current,
            });
        });
    }, [projectLoaded, projectId, updateProject, chatSessions, activeChatId, backgroundMode, showImageInfo, comfyInstanceId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        activeProjectIdRef.current = projectId;
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        graphIndexRef.current = graphIndex;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, graphIndex, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    // Keyed on projectLoaded because the canvas is not in the tree until the project finishes
    // loading (see the early return near the end of this component): a mount-only effect would
    // always see a null ref, bail out, and leave `size` at its 1200x720 default forever. Every
    // size-based centering (fit, focusNode, the zoom slider, the minimap viewport rect) would then
    // measure against the wrong box and land off-centre toward the top-left. This must stay a
    // measurement-only effect: it runs after the project-load effect that restores
    // `project.viewport`, so setting a viewport here would clobber the saved one on every open.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            containerRectRef.current = rect;
            setSize({ width: rect.width, height: rect.height });
        };
        // Scrolling an ancestor moves the container without changing its size, so the
        // ResizeObserver alone would not notice. Drop the cache and re-measure on the next read.
        const invalidateRect = () => {
            containerRectRef.current = null;
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        window.addEventListener("resize", updateSize);
        window.addEventListener("scroll", invalidateRect, true);
        return () => {
            resizeObserver.disconnect();
            window.removeEventListener("resize", updateSize);
            window.removeEventListener("scroll", invalidateRect, true);
        };
    }, [projectLoaded]);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRectRef.current ?? containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, target: ConnectionHandle) => {
            if (current.nodeId === target.nodeId) return;
            const result = prepareCanvasPortConnection(current, target, nodesRef.current, connectionsRef.current);
            if (result.error === "duplicate") return;
            if (!result.connection) {
                message.warning(result.error === "multiple_sources_for_input" ? "输入端口已连接；请先断开原连接"
                    : result.error === "incompatible_port_type" ? "端口类型不匹配"
                    : result.error === "cycle" ? "工作流连接不能形成循环"
                    : result.error === "legacy_target_not_supported" ? "工作流输出只能连接到类型化工作流输入端口"
                    : t("canvas.projectPage.configConnection"));
                return;
            }
            // Revalidate against the latest queued state: rapid user gestures must not bypass single-input rules.
            setConnections((prev) => {
                const next = prepareCanvasPortConnection(current, target, nodesRef.current, prev);
                return next.connection ? [...prev, { id: nanoid(), ...next.connection }] : prev;
            });
            setContextMenu(null);
        },
        [message, t],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count) } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const otherHandle: ConnectionHandle = { nodeId: newNode.id, handleType: pending.connection.handleType === "source" ? "target" : "source" };
            const resolved = prepareCanvasPortConnection(pending.connection, otherHandle, [...nodesRef.current, newNode], connectionsRef.current);
            if (!resolved.connection) {
                message.warning(resolved.error === "legacy_target_not_supported"
                    ? "请连接到具有类型化输入端口的工作流节点"
                    : t("canvas.projectPage.configConnection"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...resolved.connection! }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestHandle: ConnectionHandle | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            // Backwards so the first node in document order wins among equal priorities, matching
            // the previous `[...nodes].reverse().forEach` with a strict `<` comparison. Walking the
            // array in place also avoids allocating a reversed copy on every mousemove.
            const allNodes = nodesRef.current;
            const nodeById = graphIndexRef.current.nodeById;
            for (let i = allNodes.length - 1; i >= 0; i -= 1) {
                const node = allNodes[i];
                const candidate = pickCanvasDropHandle(node, current, world.y);
                const anchor = getConnectionTargetAnchor(node, current, candidate?.portId);
                const dx = world.x - anchor.x;
                const dy = world.y - anchor.y;
                const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                if (!hitsHandle && !hitsInside && !hitsExpanded) continue;
                isNearNode = true;
                if (!candidate || node.id === current.nodeId || !normalizeConnectionFromIndex(nodeById, current.nodeId, node.id, current.handleType)) continue;

                const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                if (priority < bestPriority) {
                    bestNodeId = node.id;
                    bestHandle = candidate;
                    bestPriority = priority;
                }
            }

            return { nodeId: bestNodeId, handle: bestHandle, isNearNode };
        },
        [screenToCanvas],
    );

    // Returning the previous list by reference lets memoized node/edge layers
    // skip reconciliation while the viewport transform moves unchanged items.
    const visibleNodesCacheRef = useRef<CanvasNodeData[]>([]);
    const visibleConnectionsCacheRef = useRef<CanvasConnection[]>([]);

    const visibleNodes = useMemo(() => {
        const padding = 280;
        // `size` is kept current by the ResizeObserver below. Measuring the container here instead
        // would force a synchronous layout on every pan/zoom frame.
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + size.width / viewport.k + padding * 2;
        const viewBottom = viewTop + size.height / viewport.k + padding * 2;

        const started = CANVAS_PERF_MODE ? performance.now() : 0;
        const filtered = nodes.filter((node) => node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
        if (CANVAS_PERF_MODE) {
            pipelineSink.addMs("visibleNodesMs", performance.now() - started);
            pipelineSink.count("visibleNodesCount", filtered.length);
        }
        const stable = reuseCanvasVisibleList(visibleNodesCacheRef.current, filtered);
        visibleNodesCacheRef.current = stable;
        return stable;
    }, [nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const nodeById = graphIndex.nodeById;
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const videoFrameNode = videoFrameNodeId ? nodeById.get(videoFrameNodeId) || null : null;
    const audioTrimNode = audioTrimNodeId ? nodeById.get(audioTrimNodeId) || null : null;
    useLayoutEffect(() => {
        if (!videoFrameNodeId) return;
        const identity = videoFrameNode ? `${projectId}:${videoFrameNode.id}:${videoFrameNode.metadata?.storageKey || ""}:${videoFrameNode.metadata?.content || ""}` : null;
        if (identity !== videoFrameIdentityRef.current) setVideoFrameNodeId(null);
    }, [projectId, videoFrameNodeId, videoFrameNode]);
    useLayoutEffect(() => {
        if (!audioTrimNodeId) return;
        const identity = audioTrimNode ? `${projectId}:${audioTrimNode.id}:${audioTrimNode.metadata?.storageKey || ""}:${audioTrimNode.metadata?.content || ""}` : null;
        if (identity !== audioTrimIdentityRef.current) setAudioTrimNodeId(null);
    }, [projectId, audioTrimNodeId, audioTrimNode]);
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const previewContent = previewImageId ? previewNode?.metadata?.images?.find((image) => image.id === previewImageId)?.content : previewNode?.metadata?.content;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const canGroupSelectedNodes = hasMultipleSelectedNodes &&
        [...selectedNodeIds].every((id) => {
            const node = nodeById.get(id);
            return node !== undefined && node.type !== CanvasNodeType.Group;
        });
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const groupChildCountById = graphIndex.groupChildCountById;
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);

    // Only rendering is culled. `connections` stays the source of truth for references, generation
    // inputs and group logic, so an off-screen edge is still fully functional.
    const visibleConnections = useMemo(() => {
        const started = CANVAS_PERF_MODE ? performance.now() : 0;
        const culled = cullConnections(connections, nodeById, worldViewRect(viewport, size), {
            margin: CONNECTION_CULL_MARGIN / viewport.k,
            // Keep the selected edge so its inline disconnect button cannot vanish under the user.
            keepIds: selectedConnectionId ? new Set([selectedConnectionId]) : undefined,
        });
        if (CANVAS_PERF_MODE) {
            pipelineSink.addMs("visibleConnectionsMs", performance.now() - started);
            pipelineSink.count("visibleConnectionsCount", culled.length);
        }
        const stable = reuseCanvasVisibleList(visibleConnectionsCacheRef.current, culled);
        visibleConnectionsCacheRef.current = stable;
        return stable;
    }, [connections, nodeById, selectedConnectionId, size, viewport]);

    // Resource references and generation inputs used to be precomputed here for every node on every
    // change, which was O(N x (N + E)) and re-ran on every drag frame. They are now derived per node
    // by the panel components that show them (see canvas-graph-context.tsx).

    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Built-in image, video, and config nodes retain their existing open-on-create behavior.
            const wantsPanel = definition?.hidePanel ? false : definition?.autoOpenPanel || definition?.useBuiltinPanel ? true : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group;
            if (wantsPanel) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    const groupSelectedNodes = useCallback(() => {
        const selected = selectedNodeIdsRef.current;
        if (selected.size < 2) return false;
        const template = createCanvasNode(CanvasNodeType.Group, { x: 0, y: 0 });
        const result = groupSelectedCanvasNodes(nodesRef.current, selected, template);
        if (!result) return false;

        setNodes(result.nodes);
        setSelectedNodeIds(new Set([result.group.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        return true;
    }, []);

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    return node;
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setExpandedImageNodeIds((current) => new Set([...current].filter((nodeId) => !allIds.has(nodeId))));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    // Stable identities so memoized ConnectionPath instances bail out when only one edge changes.
    const handleConnectionSelect = useCallback((connectionId: string) => {
        setSelectedConnectionId(connectionId);
        setSelectedNodeIds(new Set());
        setContextMenu(null);
    }, []);

    const handleConnectionContextMenu = useCallback((event: ReactMouseEvent<SVGPathElement>, connectionId: string) => {
        setSelectedConnectionId(connectionId);
        setSelectedNodeIds(new Set());
        setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId });
    }, []);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const cancelViewportAnimation = useCallback(() => {
        if (viewportAnimRef.current) cancelAnimationFrame(viewportAnimRef.current);
        viewportAnimRef.current = null;
    }, []);

    // Shared 450ms ease-out tween. Fit and focus share one rAF handle, so starting either one
    // cancels the other instead of the two fighting over the transform.
    const animateViewport = useCallback(
        (target: ViewportTransform) => {
            cancelViewportAnimation();
            const start = { ...viewportRef.current };
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const t = easeOutCubic(Math.min((now - startTime) / duration, 1));
                setViewport(previous=>preserveValidCanvasViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t },previous));
                viewportAnimRef.current = t < 1 ? requestAnimationFrame(step) : null;
            };
            viewportAnimRef.current = requestAnimationFrame(step);
        },
        [cancelViewportAnimation],
    );

    const handleViewportChange = useCallback(
        (next: ViewportTransform) => {
            // A user-driven pan/zoom has to win over an in-flight animation: wheel zoom and the
            // minimap derive their next transform from the committed viewport, so letting the rAF
            // keep writing would pull the canvas back to a stale target on the following frame.
            cancelViewportAnimation();
            setViewport(previous=>preserveValidCanvasViewport(next,previous));
            setContextMenu(null);
        },
        [cancelViewportAnimation],
    );

    const fitViewport = useCallback(() => {
        setContextMenu(null);
        animateViewport(fitViewportToNodes(nodesRef.current, size));
    }, [animateViewport, size.height, size.width]);

    const focusSelectedNodes = useCallback(() => {
        const target = focusSelectionViewport(nodesRef.current, selectedNodeIdsRef.current, size);
        if (!target) return false;
        animateViewport(target);
        return true;
    }, [animateViewport, size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height), 0.05), 1);
            const target = { x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k };
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            animateViewport(target);
        },
        [animateViewport, size.height, size.width],
    );

    useEffect(() => () => void (viewportAnimRef.current && cancelAnimationFrame(viewportAnimRef.current)), []);

    const setZoomScale = useCallback(
        (scale: number) => {
            cancelViewportAnimation();
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => preserveValidCanvasViewport({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            },prev));
            setContextMenu(null);
        },
        [cancelViewportAnimation, size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setComfyInstanceId(entry.comfyInstanceId);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(async () => {
        try{
            await awaitCanvasStorePersistence();
            const id=await createProject(t("canvas.defaultTitle",{count:useCanvasStore.getState().projects.length+1}));
            navigate("/canvas/"+id);
        }catch(error){message.error("项目创建失败："+String(error))}
    },[createProject,message,navigate,t]);

    const deleteCurrentProject = useCallback(async () => {
        try{await deleteProjects([projectId]);navigate("/canvas")}
        catch(error){message.error("项目删除失败："+String(error))}
    },[deleteProjects,message,navigate,projectId]);

    const exportCurrentProject = useCallback(async () => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return message.error(t("canvas.projectPage.notFound"));
        const hide = message.loading(t("canvas.projectPage.exporting"), 0);
        try {
            await exportCanvasProjects([project], project.title || t("canvas.title"));
            message.success(t("canvas.projectPage.exported"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
        }
    }, [message, projectId, t]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            // Fresh gesture: let the first frame's result through the change guard.
            marqueeSelectionRef.current = null;
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        // A frame from a previous gesture must never apply against the new drag state.
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        // Dragging a group takes its children along. Reads the adjacency index instead of rescanning
        // every node once per selected group, which was O(N^2) for a group drag.
        const index = graphIndexRef.current;
        nextSelected.forEach((id) => {
            if (index.nodeById.get(id)?.type !== CanvasNodeType.Group) return;
            for (const child of index.groupChildrenByGroupId.get(id) ?? []) dragIds.add(child.id);
        });

        const movedNodes = currentNodes.filter((node) => dragIds.has(node.id));
        const initialPositions = new Map<string, { x: number; y: number }>();
        for (const node of movedNodes) initialPositions.set(node.id, { x: node.position.x, y: node.position.y });

        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            suppressClickPanel: Boolean((event.target as HTMLElement).closest?.("[data-canvas-video-cover]")),
            initialPositions,
            movedNodes,
            // Snapshotted once. Candidates are in reverse array order so the frame loop can take the
            // first hit, matching `findGroupDropTarget`'s "last group in document order wins".
            reversedCandidateGroups: currentNodes.filter((node) => node.type === CanvasNodeType.Group && !dragIds.has(node.id)).reverse(),
            latestDelta: { dx: 0, dy: 0 },
            lastDropTargetId: null,
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        // Cleared only if this call actually owns a drag. Resize now sets the same flag, and a window
        // mouseup during a resize lands here too — clearing unconditionally would end the resize's
        // transaction early. Drag start always sets `isDraggingNode` before any move can reach here,
        // so scoping the clear to that cannot strand the flag.
        const wasDragging = dragRef.current.isDraggingNode;
        if (wasDragging) historyPausedRef.current = false;
        if (!wasDragging) return;

        const wasClick = !dragRef.current.hasMoved && !dragRef.current.suppressClickPanel && dragRef.current.movedNodes.length === 1;
        const clickedNodeId = dragRef.current.movedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialPositions;

        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            const movedIds = new Set(initialPositions.keys());
            setNodes((prev) => {
                const moved = prev.map((node) => {
                    const initial = initialPositions.get(node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                const targetGroup = findGroupDropTarget(movedIds, moved);
                if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);
                return moved.map((node) => {
                    if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                    const groupId = findContainingGroupId(node, moved);
                    if (node.metadata?.groupId === groupId) return node;
                    return { ...node, metadata: { ...node.metadata, groupId } };
                });
            });
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialPositions = new Map();
        dragRef.current.suppressClickPanel = false;
        dragRef.current.movedNodes = [];
        dragRef.current.reversedCandidateGroups = [];
        dragRef.current.lastDropTargetId = null;
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
            if (clickedDefinition?.hidePanel) {
                // Clicking a display-only plugin node selects it without opening a lower panel.
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const drag = dragRef.current;
                const dx = (event.clientX - drag.startX) / currentViewport.k;
                const dy = (event.clientY - drag.startY) / currentViewport.k;
                if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
                    drag.hasMoved = true;
                }
                drag.latestDelta = { dx, dy };

                // Coalesce rather than cancel-and-reschedule: under a high input rate the cancel/
                // requeue pattern can starve the paint. One frame stays pending and always reads the
                // newest delta. The expensive part (rebuilding the preview array and searching for a
                // group target) now runs at most once per frame instead of once per mousemove.
                if (rafRef.current) return;
                rafRef.current = requestAnimationFrame(() => {
                    rafRef.current = null;
                    const { dx: frameDx, dy: frameDy } = drag.latestDelta;
                    const initialPositions = drag.initialPositions;
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.get(node.id);
                            return initial ? { ...node, position: { x: initial.x + frameDx, y: initial.y + frameDy } } : node;
                        }),
                    );
                    const targetId = findGroupDropTargetFromDelta(drag.movedNodes, drag.reversedCandidateGroups, frameDx, frameDy)?.id ?? null;
                    // Only touch React state when the target actually changes.
                    if (drag.lastDropTargetId !== targetId) {
                        drag.lastDropTargetId = targetId;
                        setDropTargetGroupId(targetId);
                    }
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectionDropTarget, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                if (marqueeRafRef.current) {
                    cancelAnimationFrame(marqueeRafRef.current);
                    marqueeRafRef.current = null;
                }
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            // Record and schedule; the intersect pass runs once per frame rather than per event.
            marqueePointerRef.current = { clientX: event.clientX, clientY: event.clientY };
            if (marqueeRafRef.current) return;
            marqueeRafRef.current = requestAnimationFrame(() => {
                marqueeRafRef.current = null;
                const pointer = marqueePointerRef.current;
                const box = selectionBoxRef.current;
                if (!pointer || !box) return;

                const world = screenToCanvas(pointer.clientX, pointer.clientY);
                const rectX = Math.min(box.startWorldX, world.x);
                const rectY = Math.min(box.startWorldY, world.y);
                const rectW = Math.abs(world.x - box.startWorldX);
                const rectH = Math.abs(world.y - box.startWorldY);
                const nextSelected = new Set<string>(box.additive ? box.initialSelectedNodeIds : []);

                for (const node of nodesRef.current) {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                }

                const nextSelectionBox = { ...box, currentWorldX: world.x, currentWorldY: world.y };
                selectionBoxRef.current = nextSelectionBox;
                setSelectionBox(nextSelectionBox);

                // Selection only changes when the marquee crosses a node edge, so most frames can
                // skip the state update entirely.
                const previous = marqueeSelectionRef.current;
                if (!previous || previous.size !== nextSelected.size || [...nextSelected].some((id) => !previous.has(id))) {
                    marqueeSelectionRef.current = nextSelected;
                    setSelectedNodeIds(nextSelected);
                }
            });
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.handle) {
                    connectNodes(currentConnection, dropTarget.handle);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success(t("canvas.projectPage.clipboardImageAdded"));
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, t]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]"))
                return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isFocusSelectionKey(event)) {
                if (editingGestureActive || isCanvasPanning || contextMenu || nodeCreatePosition || pendingConnectionCreate || isFocusSelectionBlocked(target)) return;
                if (focusSelectedNodes()) event.preventDefault();
                return;
            }

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (key === "g" && !isModifierShortcut && !event.altKey && !event.shiftKey &&
                !event.repeat && !event.isComposing && !target?.closest("button,[role='dialog'],.ant-modal,.ant-popover,.ant-dropdown")) {
                if (groupSelectedNodes()) event.preventDefault();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [contextMenu, copySelectedNodes, deleteConnection, deleteNodes, editingGestureActive, focusSelectedNodes, groupSelectedNodes, isCanvasPanning, nodeCreatePosition, pendingConnectionCreate, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, undoCanvas]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target", portId?: string) => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType, portId });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);
    const handleGeneratedImageDimensions = useCallback((nodeId:string,width:number,height:number)=>{
        setNodes(prev=>{
            let changed=false;
            const next=prev.map(node=>{
                if(node.id!==nodeId)return node;
                const recovered=recoverLegacyGeneratedImageSize(node,width,height);
                if(recovered!==node)changed=true;
                return recovered;
            });
            return changed?next:prev;
        });
    },[]);
    const handleGeneratedVideoDimensions = useCallback((nodeId:string,width:number,height:number,source:"poster"|"video")=>{
        setNodes(prev=>{
            let changed=false;
            const next=prev.map(node=>{
                if(node.id!==nodeId)return node;
                const recovered=recoverLegacyGeneratedVideoSize(node,width,height,source);
                if(recovered!==node)changed=true;
                return recovered;
            });
            return changed?next:prev;
        });
    },[]);

    const handleNodeResizeStart = useCallback(() => {
        setIsNodeResizing(true);
        // Same transaction boundary a node drag already has. Without it the history and persistence
        // effects stay live through the gesture: the 180ms history debounce splits one continuous
        // resize into several undo entries, and every settled frame re-serialises the whole store.
        historyPausedRef.current = true;
    }, []);
    const handleNodeResizeEnd = useCallback(() => {
        setIsNodeResizing(false);
        historyPausedRef.current = false;
    }, []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        setExpandedImageNodeIds((current) => {
            const next = new Set(current);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }, []);

    const setBatchPrimary = useCallback((nodeId: string, imageId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const image = node.metadata?.images?.find((item) => item.id === imageId);
                if (!image?.content) return node;
                const edge = Math.max(node.width, node.height);
                const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
                return {
                    ...node,
                    position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...node.metadata,
                        content: image.content,
                        storageKey: image.storageKey,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        bytes: image.bytes,
                        mimeType: image.mimeType,
                        primaryImageId: image.id,
                    },
                };
            }),
        );
    }, []);

    const duplicateBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const id = nanoid();
        const edge = Math.max(node.width, node.height);
        const size = fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
        const copy: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: node.title,
            position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content: image.content,
                storageKey: image.storageKey,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                status: NODE_STATUS_SUCCESS,
                prompt: node.metadata?.prompt,
                generationType: node.metadata?.generationType,
                model: node.metadata?.model,
                size: node.metadata?.size,
                quality: node.metadata?.quality,
                background: node.metadata?.background,
                references: node.metadata?.references,
            },
        };
        setNodes((prev) => [...prev, copy]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const downloadNodeImage = useCallback((node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        saveAs(node.metadata.content, `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content)}`);
    }, []);

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            try {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"), coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                await awaitAssetStorePersistence();
            message.success(t("common.addedToAssets"));
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error(t("canvas.projectPage.noVideoToSave"));
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"),
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                await awaitAssetStorePersistence();
            message.success(t("common.addedToAssets"));
                return;
            }
            if (!node.metadata?.content) return message.error(t("canvas.projectPage.noImageToSave"));
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasImage"),
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            await awaitAssetStorePersistence();
            message.success(t("common.addedToAssets"));
            } catch(error) { message.error(String(error)); }
        },
        [addAsset, message, t],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(
                    CanvasNodeType.Text,
                    { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY },
                    { content: t("canvas.projectPage.reversePreset"), prompt: t("canvas.projectPage.reversePreset"), status: NODE_STATUS_SUCCESS, fontSize: 14 },
                ),
                title: t("canvas.projectPage.reverseTitle"),
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: t("canvas.reverseComposer", { imageId: node.id, textId: textNode.id }),
                    },
                ),
                title: t("canvas.projectPage.reverseConfigTitle"),
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, t],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    const captureVideoFrame = useCallback(async (source: CanvasNodeData, blob: Blob, timeMs: number) => {
        const projectAtStart = projectId;
        const sourceContent = source.metadata?.content;
        const sourceStorageKey = source.metadata?.storageKey;
        const liveSource = nodesRef.current.find((item) => item.id === source.id);
        if (!pageMountedRef.current || !sourceContent || activeProjectIdRef.current !== projectAtStart || !liveSource || liveSource.type !== CanvasNodeType.Video || liveSource.metadata?.content !== sourceContent || liveSource.metadata?.storageKey !== sourceStorageKey) return;
        const image = await uploadImage(blob);
        const stillCurrent = pageMountedRef.current && activeProjectIdRef.current === projectAtStart && nodesRef.current.some((item) => item.id === source.id && item.type === CanvasNodeType.Video && item.metadata?.content === sourceContent && item.metadata?.storageKey === sourceStorageKey);
        if (!stillCurrent) { await deleteStoredImages([image.storageKey]); return; }
        const size = fitNodeSize(image.width, image.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const placed = findVideoFramePosition(source, size, nodesRef.current);
        const id = nanoid();
        const stamp = `${Math.floor(timeMs / 60000)}:${((timeMs % 60000) / 1000).toFixed(2).padStart(5, "0")}`;
        const child: CanvasNodeData = {
            id, type: CanvasNodeType.Image,
            title: t("canvas.projectPage.videoFrameNodeTitle", { name: source.title || t("canvas.node.video"), time: stamp }),
            position: placed, width: size.width, height: size.height,
            metadata: { ...imageMetadata(image), videoFrame: { sourceNodeId: source.id, timeMs } },
        };
        if (historyCommitTimerRef.current) { clearTimeout(historyCommitTimerRef.current); historyCommitTimerRef.current = null; }
        const previous = createHistoryEntry();
        const baseline = lastHistoryRef.current;
        const past = [...historyRef.current.past];
        if (baseline && !sameCanvasHistoryEntry(baseline, previous)) past.push(baseline);
        past.push(previous);
        historyRef.current.past = past.slice(-50);
        historyRef.current.future = [];
        setHistoryState({ canUndo: true, canRedo: false });
        const nextNodes = [...nodesRef.current, child];
        const nextConnections = [...connectionsRef.current, { id: nanoid(), fromNodeId: source.id, toNodeId: id }];
        const nextHistory: CanvasHistoryEntry = { ...previous, nodes: nextNodes, connections: nextConnections };
        lastHistoryRef.current = nextHistory;
        nodesRef.current = nextNodes; connectionsRef.current = nextConnections;
        setNodes(nextNodes); setConnections(nextConnections);
        setSelectedNodeIds(new Set([id])); setSelectedConnectionId(null);
        message.success(t("canvas.videoFrame.captureSuccess"));
    }, [createHistoryEntry, message, projectId, t]);

    const trimAudioNode = useCallback(async (source: CanvasNodeData, blob: Blob, startMs: number, endMs: number, durationMs: number, signal: AbortSignal) => {
        const projectAtStart = projectId;
        const sourceContent = source.metadata?.content;
        const sourceStorageKey = source.metadata?.storageKey;
        const isCurrent = () => pageMountedRef.current && activeProjectIdRef.current === projectAtStart && nodesRef.current.some((item) => item.id === source.id && item.type === CanvasNodeType.Audio && item.metadata?.content === sourceContent && item.metadata?.storageKey === sourceStorageKey);
        if (!sourceContent || !isCurrent()) return;
        let audio: Awaited<ReturnType<typeof uploadMediaFile>> | null = null;
        try {
            audio = await uploadMediaFile(blob, "audio");
            if (signal.aborted || !isCurrent()) { await deleteStoredMedia([audio.storageKey]); return; }
            const id = nanoid();
            const startLabel = `${Math.floor(startMs / 60000)}:${((startMs % 60000) / 1000).toFixed(2).padStart(5, "0")}`;
            const endLabel = `${Math.floor(endMs / 60000)}:${((endMs % 60000) / 1000).toFixed(2).padStart(5, "0")}`;
            const baseName = (source.title || t("canvas.node.audio")).replace(/\.\w+$/, "");
            const width = NODE_DEFAULT_SIZE[CanvasNodeType.Audio].width;
            const height = NODE_DEFAULT_SIZE[CanvasNodeType.Audio].height;
            const position = findVideoFramePosition(source, { width, height }, nodesRef.current);
            const trimmedAudio = { ...audio, durationMs };
            const child: CanvasNodeData = { id, type: CanvasNodeType.Audio, title: t("canvas.audioTrim.nodeTitle", { name: baseName, start: startLabel, end: endLabel }), position, width, height, metadata: { ...audioMetadata(trimmedAudio), audioTrim: { sourceNodeId: source.id, startMs, endMs } } };
            if (historyCommitTimerRef.current) { clearTimeout(historyCommitTimerRef.current); historyCommitTimerRef.current = null; }
            const previous = createHistoryEntry(); const baseline = lastHistoryRef.current; const past = [...historyRef.current.past];
            if (baseline && !sameCanvasHistoryEntry(baseline, previous)) past.push(baseline);
            past.push(previous); historyRef.current.past = past.slice(-50); historyRef.current.future = []; setHistoryState({ canUndo: true, canRedo: false });
            const nextNodes = [...nodesRef.current, child]; const nextConnections = [...connectionsRef.current, { id: nanoid(), fromNodeId: source.id, toNodeId: id }];
            lastHistoryRef.current = { ...previous, nodes: nextNodes, connections: nextConnections };
            nodesRef.current = nextNodes; connectionsRef.current = nextConnections; setNodes(nextNodes); setConnections(nextConnections);
            setSelectedNodeIds(new Set([id])); setSelectedConnectionId(null);
            message.success(t("canvas.audioTrim.success"));
        } catch {
            if (audio) await deleteStoredMedia([audio.storageKey]);
            message.error(t("canvas.audioTrim.failed"));
        }
    }, [createHistoryEntry, message, projectId, t]);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
        },
        [message, t],
    );

    /** Mask edits and angle redraws also use the existing model JobCoordinator.
     * The materializer creates the resulting child node; no optimistic duplicate.
     */
    const submitSqliteImageEdit = useCallback(async (
        node: CanvasNodeData, generationConfig: typeof defaultConfig,
        prompt: string, source: ReferenceImage, mask?: ReferenceImage,
    ) => {
        const channel=resolveModelChannel(effectiveConfig,generationConfig.model);
        const provider=modelChannelProvider(channel,"image");
        if(!provider||!channel)throw Error("sqlite_image_edit_provider_unsupported");
        if(!projectLoaded)throw Error("画布项目尚未加载完成");
        if(resolveModelScript(effectiveConfig,generationConfig.model))
            throw Error("自定义模型脚本暂不支持图片编辑");
        const submissionKey=projectId+":"+node.id;
        if(sqliteModelSubmitLocksRef.current.has(submissionKey))
            throw Error("该节点已有模型任务正在提交");
        sqliteModelSubmitLocksRef.current.add(submissionKey);
        try {
            await ensureSqliteModelChannelForExecution(channel,provider);
            const bridge=createSqliteComfyBridge({projectId,
                getLocalGraph:()=>({nodes:nodesRef.current,connections:connectionsRef.current})});
            const job=await startSqliteModelGeneration({
                projectId,sourceNodeId:node.id,nodes:[...nodesRef.current],
                connections:[...connectionsRef.current],channelId:channel.id,channelBaseUrl:channel.baseUrl,provider,
                referenceImages:[source],...(mask?{maskImage:mask}:{}),bridge,
                task:{kind:"image",model:modelOptionName(generationConfig.model),prompt,
                    size:openAiImageSize(generationConfig.size),
                    quality:["auto","low","medium","high"].includes(generationConfig.quality)?
                        generationConfig.quality:"auto"},
            });
            monitorSqliteJobRef.current(job.id);
            message.info("图片编辑任务已提交："+job.id+"，完成后自动追加图片节点");
        } finally {
            sqliteModelSubmitLocksRef.current.delete(submissionKey);
        }
    },[effectiveConfig,projectId,projectLoaded,message]);

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
            const userPrompt = payload.prompt.trim();
            if(modelChannelProvider(resolveModelChannel(effectiveConfig,generationConfig.model),"image")){
                const editPrompt=t("canvas.projectPage.maskPrompt",{prompt:userPrompt});
                const source:ReferenceImage={id:node.id,name:node.title||node.id,
                    type:node.metadata.mimeType||"image/png",dataUrl:node.metadata.content,
                    storageKey:node.metadata.storageKey};
                const mask:ReferenceImage={id:node.id+"-mask",name:"mask.png",type:"image/png",
                    dataUrl:payload.maskDataUrl};
                try{
                    await submitSqliteImageEdit(node,generationConfig,editPrompt,source,mask);
                    setMaskEditNodeId(null);
                }catch(error){message.error(error instanceof Error?error.message:String(error))}
                return;
            }
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const prompt = t("canvas.projectPage.maskPrompt", { prompt: userPrompt });
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || t("canvas.projectPage.maskResult"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(generationConfig, prompt, [source], { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl }, { signal: controller.signal }).then((items) => items[0]);
                const uploaded = await uploadImage(image.dataUrl);
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.maskFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, projectId, startGenerationRequest, submitSqliteImageEdit, t],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(node.metadata.content, params);
        const image = await uploadImage(upscaled);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    }, []);

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if(modelChannelProvider(resolveModelChannel(effectiveConfig,generationConfig.model),"image")){
                const source:ReferenceImage={id:node.id,name:node.title||node.id,
                    type:node.metadata.mimeType||"image/png",dataUrl:node.metadata.content,
                    storageKey:node.metadata.storageKey};
                try{
                    await submitSqliteImageEdit(node,generationConfig,buildAnglePrompt(params),source);
                    setAngleNodeId(null);
                }catch(error){message.error(error instanceof Error?error.message:String(error))}
                return;
            }
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(
                    generationConfig,
                    prompt,
                    [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }],
                    undefined,
                    { signal: controller.signal },
                ).then((items) => items[0]);
                const uploaded = await uploadImage(image.dataUrl);
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, message, openConfigDialog, startGenerationRequest, submitSqliteImageEdit, t],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f));
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const basePosition = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const STAGGER = 40; // Offset between multiple imported files.

            // When replacing a target node, use the first file as the replacement and create the rest nearby.
            if (target?.nodeId) {
                const [first, ...rest] = files;

                // Replace the target node with the first file.
                if (isAudioFile(first)) {
                    const audio = await uploadMediaFile(first, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await uploadMediaFile(first, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const image = await uploadImage(first);
                    const s = fitNodeSize(image.width, image.height);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: first.name,
                                      width: s.width,
                                      height: s.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          images: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          count: undefined,
                                          references: undefined,
                                          primaryImageId: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                }

                // Create the remaining files near the target node.
                for (let i = 0; i < rest.length; i++) {
                    const offsetPos = { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER };
                    const f = rest[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            } else {
                // Without a replacement target, create all files near the canvas center.
                for (let i = 0; i < files.length; i++) {
                    const offsetPos = { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER };
                    const f = files[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files).filter((item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item));
            if (!files.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                if (isAudioFile(f)) {
                    void createAudioFileNode(f, pos);
                } else if (f.type.startsWith("video/")) {
                    void createVideoFileNode(f, pos);
                } else {
                    void createImageFileNode(f, pos);
                }
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProjectTitle || t("canvas.projectPage.untitledCanvas"));
        setTitleEditing(true);
    }, [currentProjectTitle, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, retryConfig?: typeof defaultConfig) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const generationConfig = retryConfig ?? buildGenerationConfig(effectiveConfig, sourceNode, mode);
            const promptText = mode === "text" ? extractSkillMentions(prompt).text : prompt;
            const selectedChannel=resolveModelChannel(effectiveConfig,generationConfig.model);
            // Supported official channels always execute via SQLite. No toggle,
            // no implicit browser fallback on a failed backend/credential check.
            const sqliteProvider=resolveModelScript(effectiveConfig,generationConfig.model)?null:modelChannelProvider(selectedChannel,mode);
            if(sqliteProvider&&selectedChannel){
                const submissionKey=projectId+":"+nodeId;
                if(sqliteModelSubmitLocksRef.current.has(submissionKey)){
                    message.warning("该来源节点的生成任务正在提交，请勿重复点击");
                    return;
                }
                sqliteModelSubmitLocksRef.current.add(submissionKey);
                try{
                    if(!projectLoaded)throw Error("画布项目尚未加载完成");
                    await ensureSqliteModelChannelForExecution(selectedChannel,sqliteProvider);
                    if(!sourceNode||!["text","config","image","audio","video"].includes(sourceNode.type)||
                      sourceNode.type==="image"&&mode!=="image"||
                      sourceNode.type==="audio"&&mode!=="audio"||
                      sourceNode.type==="video"&&mode!=="video"||
                      ["image","audio","video"].includes(sourceNode.type)&&Boolean(sourceNode.metadata?.content))
                        throw Error("当前节点类型不支持此模型生成");
                    if(resolveModelScript(effectiveConfig,generationConfig.model))
                        throw Error("自定义模型脚本尚未接入后端任务服务");
                    if(mode!=="text"&&sourceNode.metadata?.skillBinding&&sourceNode.metadata.skillBinding.mode!=="off")
                        throw Error("Skill 目前仅支持文本模型的手动指令模式");
                    if(mode==="image"&&getGenerationCount(generationConfig.count)!==1)
                        throw Error("当前图片生成每次仅支持一张，请将数量设置为 1");
                    const original=sourceNode.type===CanvasNodeType.Text?
                      sourceNode.metadata?.content?.trim():"";
                    const context=buildNodeGenerationContext(nodeId,nodesRef.current,connectionsRef.current,
                      mode==="text"&&original?t("canvas.projectPage.editTextPrompt",{source:original,prompt:promptText}):promptText);
                    if(mode!=="video"&&(context.referenceVideos.length||context.referenceAudios.length||
                        mode==="audio"&&context.referenceImages.length))
                        throw Error("当前仅支持图片生成/编辑与文本问答的图片参考输入；视频、音频参考请使用对应工作流");
                    const text=context.prompt.trim();
                    if(!text)throw Error("请输入生成提示词");
                    const model=modelOptionName(generationConfig.model);
                    const kind=mode as "image"|"audio"|"text"|"video";
                    const format=generationConfig.audioFormat;
                    if(kind==="audio"&&!["mp3","wav","flac"].includes(format))
                        throw Error("语音生成目前仅支持 MP3、WAV 或 FLAC");
                    const bridge=createSqliteComfyBridge({projectId,
                        getLocalGraph:()=>({nodes:nodesRef.current,connections:connectionsRef.current})});
                    let skillAuthorizationId:string|undefined;
                    let skillCatalog:FrozenSqliteSkillCatalog|undefined;
                    let textMessages:import("@/features/backend-sync/sqlite-model-generation").FrozenTextTurn[]|undefined;
                    if(kind==="text"){
                        const skillBinding=resolvePromptSkillBinding(prompt,sourceNode.metadata?.skillBinding);
                        if(skillBinding?.mode==="auto"&&context.referenceImages.length)
                            throw Error("自动 Skill 文本任务暂不支持同时附带参考图");
                        const auto=skillBinding?.mode==="auto"?
                            await freezeSqliteSkillCatalog(skillBinding,text,projectId,bridge):null;
                        skillCatalog=auto?.catalog;
                        skillAuthorizationId=auto?.authorizationId;
                        const manual=skillBinding?.mode==="manual"?
                            await resolveManualSkillContext(skillBinding,undefined,projectId):null;
                        const adapted=manual?withManualSkillMessages([{role:"user",content:text}],manual):null;
                        const compiled=auto?
                            auto.catalogMessage+"\n\n<user-request>\n"+text+"\n</user-request>":
                            adapted?.[0]?.content??text;
                        if(typeof compiled!=="string"||new TextEncoder().encode(compiled).length>16000)
                            throw Error("文本提示词与 Skill 上下文合计超过 16 KB 限制");
                        textMessages=[
                            ...(generationConfig.systemPrompt.trim()?[
                                {role:"system" as const,content:generationConfig.systemPrompt.trim()}]:[]),
                            {role:"user",content:compiled}
                        ];
                    }
                    let seedanceMode:"text_to_video"|"first_frame"|"first_last_frame"|"omni_reference"|undefined;
                    let frozenReferences:Awaited<ReturnType<typeof freezeSeedanceReferences>>|undefined;
                    if(kind==="video"){
                        const request=makeVideoGenerationRequest(generationConfig,text,generationConfig.model,context,
                            sourceNode.metadata?.videoReferences);
                        const modelConfig=selectedChannel.models.find(entry=>entry.name===model);
                        const caps=modelConfig?capabilitiesForModel(selectedChannel,modelConfig):null;
                        if(caps)validateSeedanceRequest(request,caps);
                        seedanceMode=request.mode;
                        if(request.references.some(ref=>ref.kind==="video"&&
                            !ref.url?.startsWith("asset://"))){
                            const capability=await canvasApi<{arkAssetUploadReady:boolean}>(
                                "/api/v1/execution/capabilities");
                            if(!capability.arkAssetUploadReady)
                                throw Error("本地视频上传方舟素材库尚未配置：请配置方舟 AK/SK、素材组和 TOS Bucket 后重启后端");
                        }
                        frozenReferences=await freezeSeedanceReferences(request,bridge);
                    }
                    const job=await startSqliteModelGeneration({
                        projectId,sourceNodeId:nodeId,
                        nodes:[...nodesRef.current],connections:[...connectionsRef.current],
                        channelId:selectedChannel.id,channelBaseUrl:selectedChannel.baseUrl,
                        provider:sqliteProvider,
                        ...(skillAuthorizationId?{skillAuthorizationId}:{}),
                        bridge,
                        ...(kind==="image"||kind==="text"?{referenceImages:context.referenceImages}:{}),
                        task:{kind,model,prompt:kind==="text"?textMessages!.at(-1)!.content:text,
                          ...(kind==="text"?{stream:true,messages:textMessages,
                            ...(skillCatalog?{skills:skillCatalog}:{})}:{}),
                          ...(kind==="image"?{size:openAiImageSize(generationConfig.size),
                            quality:["auto","low","medium","high"].includes(generationConfig.quality)?
                              generationConfig.quality:"auto"}:{}),
                          ...(kind==="audio"?{voice:generationConfig.audioVoice,format,
                            speed:Number(generationConfig.audioSpeed)||1}:{}),
                          ...(kind==="video"?{duration:Math.max(4,Math.min(15,Math.floor(Number(generationConfig.videoSeconds)||6))),
                            ratio:["16:9","9:16","1:1","4:3","3:4","21:9"].includes(generationConfig.videoRatio)?generationConfig.videoRatio:"adaptive",
                            resolution:["480p","720p","1080p"].includes(generationConfig.vquality)?generationConfig.vquality:
                              ["480","720","1080"].includes(generationConfig.vquality)?generationConfig.vquality+"p":"720p",
                            generateAudio:generationConfig.videoGenerateAudio!=="false",
                            watermark:generationConfig.videoWatermark==="true",
                            mode:seedanceMode,references:frozenReferences}:{})}
                    });
                    message.info("模型任务已提交："+job.id+"，完成后自动追加产物节点");
                    if(kind==="video"){sqliteGenerationJobsRef.current.set(nodeId,job.id);setRunningNodeId(nodeId)}
                    monitorSqliteJobRef.current(job.id);
                }catch(error){message.error(error instanceof Error?error.message:String(error))}
                finally{sqliteModelSubmitLocksRef.current.delete(submissionKey)}
                return;
            }
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) return;
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    // Upstream image nodes become references; without them this is text-to-image.
                    const upstreamNodes = connectionsRef.current
                        .filter((conn) => conn.toNodeId === nodeId)
                        .map((conn) => nodesRef.current.find((node) => node.id === conn.fromNodeId))
                        .filter((node): node is CanvasNodeData => Boolean(node));
                    const refs = upstreamNodes.flatMap((up) =>
                        typeof up.metadata?.content === "string" && up.metadata.content && up.type !== sourceNode.type
                            ? [{ id: up.id, name: `${up.title || up.id}.png`, type: up.metadata.mimeType || "image/png", dataUrl: up.metadata.content, storageKey: up.metadata.storageKey }]
                            : [],
                    );
                    const image = refs.length
                        ? await requestEdit({ ...generationConfig, count: "1" }, fullPrompt, refs, undefined, { signal: controller.signal }).then((items) => items[0])
                        : await requestGeneration({ ...generationConfig, count: "1" }, fullPrompt, { signal: controller.signal }).then((items) => items[0]);
                    const uploaded = await uploadImage(image.dataUrl);
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                    );
                    setDialogNodeId(null);
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                }
                return;
            }

            setRunningNodeId(nodeId);
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt: promptText }) : promptText),
            );
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus)
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Config ? {} : { prompt }), status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const sourceReference =
                        isImageNode && sourceNode?.metadata?.content
                            ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata.mimeType || "image/png", dataUrl: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey }]
                            : [];
                    const referenceImages = sourceReference.length ? sourceReference : generationContext.referenceImages;
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const imageIds = Array.from({ length: count }, () => nanoid());
                    pendingChildIds = [rootId];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            images: imageIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "", storageKey: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
                            ...generationMetadata,
                        },
                    };

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                    ]);
                    if (!isEmptyImageNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    const succeededImages: GenerationHistoryImage[] = [];
                    await Promise.all(
                        imageIds.map(async (imageId) => {
                            try {
                                const image = referenceImages.length
                                    ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, undefined, { signal: controller.signal }).then((items) => items[0])
                                    : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, { signal: controller.signal }).then((items) => items[0]);
                                const uploaded = await uploadImage(image.dataUrl);
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                const item: CanvasNodeImage = {
                                    id: imageId,
                                    status: NODE_STATUS_SUCCESS,
                                    content: uploaded.url,
                                    storageKey: uploaded.storageKey,
                                    naturalWidth: uploaded.width,
                                    naturalHeight: uploaded.height,
                                    bytes: uploaded.bytes,
                                    mimeType: uploaded.mimeType,
                                };
                                setNodes((prev) =>
                                    prev.map((node) => {
                                        if (node.id !== rootId) return node;
                                        const images = node.metadata?.images?.map((image) => (image.id === imageId ? item : image)) || [];
                                        if (node.metadata?.primaryImageId) return { ...node, metadata: { ...node.metadata, images } };
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        return {
                                            ...node,
                                            position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                            ...imageSize,
                                            metadata: {
                                                ...node.metadata,
                                                content: item.content,
                                                storageKey: item.storageKey,
                                                naturalWidth: item.naturalWidth,
                                                naturalHeight: item.naturalHeight,
                                                bytes: item.bytes,
                                                mimeType: item.mimeType,
                                                images,
                                                primaryImageId: imageId,
                                            },
                                        };
                                    }),
                                );
                                hasSuccess = true;
                                succeededImages.push({ storageKey: uploaded.storageKey, mimeType: uploaded.mimeType, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes });
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                                if (!firstError) firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) =>
                                    prev.map((node) =>
                                        node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : node,
                                    ),
                                );
                            }
                            return false;
                        }),
                    );
                    if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                    if (succeededImages.length) {
                        useGenerationHistoryStore.getState().addRecord({
                            prompt: effectivePrompt,
                            model: generationConfig.model || "",
                            images: succeededImages,
                            successCount: succeededImages.length,
                            failCount: count - succeededImages.length,
                        });
                    }
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? t("canvas.projectPage.partialFailed") : firstError || t("canvas.projectPage.generationFailed"));
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                : node.id === rootId
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.allFailed") } }
                                  : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const videoId = isEmptyVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: isEmptyVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: isEmptyVideoNode ? sourceNode.width : spec.width,
                        height: isEmptyVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            videoMode: generationConfig.videoMode,
                            videoRatio: generationConfig.videoRatio,
                            returnLastFrame: generationConfig.videoReturnLastFrame,
                            videoReferences: makeVideoGenerationRequest(generationConfig, effectivePrompt, generationConfig.model, generationContext, sourceNode?.metadata?.videoReferences).references.map(({ id, kind, role, storageKey, url, mimeType, durationMs, bytes }) => ({ id, kind, role, storageKey, url, mimeType, durationMs, bytes })),
                            references: generationReferenceUrls(generationContext),
                        },
                    };
                    pendingChildIds = [videoId];
                    const nextNodes = isEmptyVideoNode
                        ? nodesRef.current.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                        : [...nodesRef.current.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode];
                    nodesRef.current = nextNodes;
                    setNodes(nextNodes);
                    if (!isEmptyVideoNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]);
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    try {
                        let generationTask: VideoGenerationTask | null = null;
                        const request = makeVideoGenerationRequest(generationConfig, effectivePrompt, generationConfig.model, generationContext, sourceNode?.metadata?.videoReferences);
                        if (isNativeArkVideo(generationConfig, generationConfig.model)) {
                            const videoRequest = { ...request, references: request.references.map(({ dataUrl, storageKey, ...reference }) => ({ ...reference, ...(storageKey ? { storageKey } : dataUrl ? { dataUrl } : {}) })) };
                            nodesRef.current = nodesRef.current.map((item) => item.id === videoId ? { ...item, metadata: { ...item.metadata, videoRequest } } : item);
                            setNodes(nodesRef.current);
                            updateProject(projectId, { nodes: nodesRef.current });
                            flushCanvasStorePersistence();
                        }
                        const generatedVideo = await requestVideoGeneration(generationConfig, effectivePrompt, generationContext.referenceImages, {
                            signal: controller.signal,
                            request,
                            onTaskCreated: (task) => {
                                generationTask = task;
                                persistVideoTask(videoId, task);
                            },
                            onTaskStatus: (status) => generationTask && persistVideoTask(videoId, { ...generationTask, status }, status),
                        });
                        const video = await storeGeneratedVideo(generatedVideo);
                        const lastFrame = generatedVideo.lastFrameBlob ? await saveArkLastFrame(generatedVideo.lastFrameBlob) : undefined;
                        if (generationTask) persistVideoTask(videoId, generationTask, "succeeded");
                        const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === videoId
                                    ? {
                                          ...node,
                                          width: videoSize.width,
                                          height: videoSize.height,
                                          position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                          metadata: {
                                              ...node.metadata,
                                              ...videoMetadata(video),
                                              prompt: effectivePrompt,
                                              model: generationConfig.model,
                                              size: generationConfig.size,
                                              seconds: generationConfig.videoSeconds,
                                              vquality: generationConfig.vquality,
                                              generateAudio: generationConfig.videoGenerateAudio,
                                              watermark: generationConfig.videoWatermark,
                                              videoMode: generationConfig.videoMode,
                                              videoRatio: generationConfig.videoRatio,
                                              returnLastFrame: generationConfig.videoReturnLastFrame,
                                              ...(generationTask ? { videoTask: { provider: generationTask.provider, channelId: generationTask.channelId, model: generationTask.model, taskId: generationTask.id, startedAt: generationTask.startedAt || Date.now(), status: "succeeded" as const } } : {}),
                                              ...(generatedVideo.lastFrameUrl ? { lastFrameUrl: generatedVideo.lastFrameUrl } : {}),
                                              ...(lastFrame ? { lastFrame } : {}),
                                              references: generationReferenceUrls(generationContext),
                                          },
                                      }
                                    : node,
                            ),
                        );
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const audioId = isEmptyAudioNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: isEmptyAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: isEmptyAudioNode ? sourceNode.width : spec.width,
                        height: isEmptyAudioNode ? sourceNode.height : spec.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        isEmptyAudioNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!isEmptyAudioNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
                    const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, effectivePrompt, { signal: controller.signal }), generationConfig.audioFormat);
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...buildAudioGenerationMetadata(generationConfig) } } : node)));
                    } finally {
                        finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                const requestedSkills = resolvePromptSkillBinding(prompt, sourceNode?.metadata?.skillBinding);
                const manualSkills = requestedSkills?.mode === "manual" ? await resolveManualSkillContext(requestedSkills, undefined, projectId) : null;
                const autoPlan = !manualSkills && !resolveModelScript(generationConfig, generationConfig.model) && !isSkillToolsKnownUnsupported(generationConfig)
                    ? await prepareAutomaticSkillCatalog(requestedSkills?.mode === "auto" ? requestedSkills : undefined, undefined, effectivePrompt, projectId)
                    : null;
                if (runController.signal.aborted) return;
                const defaultMessages = buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt });
                const skillMessages = manualSkills ? withManualSkillMessages(defaultMessages, manualSkills)
                    : autoPlan ? withAutomaticSkillCatalog(defaultMessages, autoPlan) : defaultMessages;
                const initialSkillRun = manualSkills?.snapshot || autoPlan?.snapshot();
                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = getGenerationCount(String(sourceNode?.metadata?.textCount || 1));
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = isConfigNode || editingTextNode || textCount > 1 ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (childIds.length) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: effectivePrompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, fontSize: 14, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort, skillRun: initialSkillRun },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))]);
                }

                const controller = runController;
                const textTargetIds = childIds.length ? childIds : [nodeId];
                textTargetIds.forEach((targetNodeId) => startGenerationRequest(targetNodeId, nodeId, nodeId, controller));
                const answers = await Promise.all(
                    textTargetIds.map(async (targetNodeId) => {
                        let localStreamed = "";
                        const autoRun = autoPlan?.createRun();
                        let toolStarted = false;
                        let toolUnsupported = false;
                        const onText = (text: string) => {
                            localStreamed = text;
                            streamed = text;
                            if (isConfigNode) return;
                            setNodes((prev) => prev.map((node) => (node.id === targetNodeId ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node)));
                        };
                        try {
                            let answer: string;
                            try {
                                answer = await requestImageQuestion(generationConfig, skillMessages, onText,
                                    { signal: controller.signal, ...(autoRun ? { agent: {
                                        tools: autoRun.tools, executeTool: autoRun.executeTool,
                                        maxToolRounds: 6, maxToolCalls: 12, maxToolOutputChars: 32768,
                                        onEvent: (event) => {
                                            if (event.type === "tool_start") toolStarted = true;
                                            autoRun.onEvent(event);
                                        },
                                    } } : {}) });
                                if (autoRun) rememberSupportedSkillTools(generationConfig);
                            } catch (error) {
                                if (!autoRun || toolStarted || controller.signal.aborted || !isUnsupportedSkillToolsError(error)) throw error;
                                // Only unsupported tool/function schemas trigger fallback; keep the original prompt.
                                rememberUnsupportedSkillTools(generationConfig);
                                toolUnsupported = true;
                                answer = await requestImageQuestion(generationConfig, defaultMessages, onText, { signal: controller.signal });
                            }
                            return { nodeId: targetNodeId, content: answer || localStreamed,
                                skillRun: toolUnsupported ? undefined : autoRun?.snapshot() || manualSkills?.snapshot,
                                skillTrace: toolUnsupported ? undefined : autoRun?.trace(),
                                skillMetrics: toolUnsupported ? undefined : autoRun?.metrics(),
                            };
                        } finally {
                            finishGenerationRequest(targetNodeId, controller);
                        }
                    }),
                );
                if (controller.signal.aborted) return;
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item]));
                const answerText = (id: string) => answerByNodeId.get(id)?.content || streamed;
                const skillResult = (id: string) => ({
                    skillRun: answerByNodeId.get(id)?.skillRun,
                    skillTrace: answerByNodeId.get(id)?.skillTrace,
                    skillMetrics: answerByNodeId.get(id)?.skillMetrics,
                });
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerText(node.id), ...skillResult(node.id), status: NODE_STATUS_SUCCESS } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Text,
                                      title: prompt.slice(0, 32) || "Generated Text",
                                      metadata: { ...node.metadata, content: answerText(node.id), model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort, ...skillResult(node.id), status: NODE_STATUS_SUCCESS },
                                  }
                                : node,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails, ...(isResumableSeedanceProvider(node.metadata?.videoTask?.provider) && node.metadata?.videoTask?.status === "succeeded" ? { videoDownloadError: errorDetails } : {}) } }) : node)),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, projectId, startGenerationRequest, t],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData, imageId?: string) => {
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? node.metadata : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, node.type === CanvasNodeType.Video && node.metadata?.videoRequest ? node : sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (node.type === CanvasNodeType.Video && isResumableSeedanceProvider(node.metadata?.videoTask?.provider) && node.metadata.videoTask.status === "succeeded" && node.metadata.videoDownloadError) {
                // Legacy Ark task IDs cannot be downloaded through the retired
                // Gateway. Do not set loading, mutate the result or resubmit.
                message.warning("旧 Ark 视频任务无法从浏览器重新下载。请检查原服务记录，保留原任务 ID；不会自动重新生成。");
                return;
            }

            // Official providers never retry through browser requestGeneration /
            // requestEdit / requestVideoGeneration. Retry means a NEW persistent
            // append-only job from the original source; keep the old result and
            // its error/history instead of silently overwriting it.
            const retryMode:CanvasNodeGenerationMode=node.type===CanvasNodeType.Text?"text":
                node.type===CanvasNodeType.Video?"video":
                node.type===CanvasNodeType.Audio?"audio":"image";
            const retryChannel=resolveModelChannel(effectiveConfig,generationConfig.model);
            if(modelChannelProvider(retryChannel,retryMode)){
                const sqliteSource=findSqliteModelRetrySource(node,nodesRef.current,connectionsRef.current);
                const retryPrompt=(
                    savedImageMetadata?.prompt||
                    node.metadata?.videoRequest?.prompt||
                    node.metadata?.prompt||
                    sqliteSource.metadata?.composerContent||
                    sqliteSource.metadata?.prompt||""
                ).trim();
                if(!retryPrompt){
                    message.warning(t("canvas.projectPage.retryPromptMissing"));
                    return;
                }
                if(node.type===CanvasNodeType.Image&&savedImageMetadata?.generationType==="edit"){
                    message.error("官方模型参考图编辑尚未接入后端任务服务；不会回退浏览器直接请求");
                    return;
                }
                // Historical result snapshots may carry references not present
                // in the current producer's dependency graph. Never replace
                // such a retry with an accidental text-only paid video job.
                if(node.type===CanvasNodeType.Video&&node.metadata?.videoRequest?.references?.length){
                    message.error("历史视频包含参考素材；请在原始来源节点重新确认参考素材后生成，不能直接重放旧请求");
                    return;
                }
                if(node.type===CanvasNodeType.Text&&node.metadata?.modelArtifact?.jobId){
                    const originalJobId=node.metadata.modelArtifact.jobId;
                    try{
                        await canvasApi("/api/v1/projects/"+encodeURIComponent(projectId)+
                            "/jobs/"+encodeURIComponent(originalJobId)+"/skill-audit");
                        message.warning("此结果使用了冻结 Skill 版本。请在「任务历史」中查看原任务并明确确认「使用冻结版本创建新任务」，以免误用当前 Skill。");
                        return;
                    }catch(error){
                        if(!(error instanceof Error&&"code" in error&&
                            error.code==="skill_job_not_supported")){
                            message.error("无法验证原任务 Skill 快照，已阻止自动重试："+String(error));
                            return;
                        }
                    }
                }
                if(node.type===CanvasNodeType.Text&&node.metadata?.skillRun){
                    message.error("原任务包含 Skill 运行记录；请从来源节点重新执行，不能将 Skill 重试改为普通模型请求");
                    return;
                }
                if(sqliteSource===node&&Boolean(sqliteSource.metadata?.content)&&
                   sqliteSource.type!==CanvasNodeType.Text){
                    message.error("原始生成来源节点已不存在，不能安全重试；请从上游配置节点重新生成");
                    return;
                }
                if(imageId)message.info("重试将创建新的产物节点，原批次图片保持不变");
                await handleGenerateNode(sqliteSource.id,retryMode,retryPrompt,generationConfig);
                return;
            }
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const context = hasSavedImageMetadata || node.metadata?.videoRequest ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const prompt = (savedImageMetadata?.prompt || node.metadata?.videoRequest?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error(t("canvas.projectPage.referenceMissing"));
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.content ? undefined : t("canvas.projectPage.referenceMissing"),
                                      images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.referenceMissing") } : image)),
                                  },
                              }
                            : item,
                    ),
                );
                return;
            }
            const retryImages = retryReferenceImages || [];

            // Resolve pinned Skills before setting the node to loading: the user may
            // decline replacing a removed version, leaving the existing output intact.
            let retryManualSkills: ManualSkillContext | null = null;
            let retryAutoPlan: AutomaticSkillPlan | null = null;
            if (node.type === CanvasNodeType.Text) {
                const inlinePrompt = sourceNode.type === CanvasNodeType.Config
                    ? sourceNode.metadata?.composerContent ?? sourceNode.metadata?.prompt ?? ""
                    : node.metadata?.composerContent ?? node.metadata?.prompt ?? "";
                const requestedSkills = resolvePromptSkillBinding(inlinePrompt, sourceNode.metadata?.skillBinding);
                const oldRun = node.metadata?.skillRun;
                const canAuto = !resolveModelScript(generationConfig, generationConfig.model);
                try {
                    if (oldRun?.mode === "manual" || (!oldRun && requestedSkills?.mode === "manual")) {
                        retryManualSkills = await resolveManualSkillContext(requestedSkills, oldRun?.mode === "manual" ? oldRun : undefined, projectId);
                    } else if (canAuto && !isSkillToolsKnownUnsupported(generationConfig)) {
                        retryAutoPlan = await prepareAutomaticSkillCatalog(undefined, oldRun?.mode === "auto" ? oldRun : undefined, prompt, projectId);
                    }
                } catch (error) {
                    if (error instanceof MissingSkillVersionError && oldRun) {
                        const replaceVersion = await new Promise<boolean>((resolve) => {
                            modal.confirm({
                                title: t("canvas.skillPicker.missingVersionTitle"),
                                content: t("canvas.skillPicker.missingVersionContent", { id: error.skillId, version: error.version }),
                                okText: t("canvas.skillPicker.useCurrent"),
                                cancelText: t("common.cancel"),
                                onOk: () => resolve(true),
                                onCancel: () => resolve(false),
                            });
                        });
                        if (!replaceVersion) return;
                        try {
                            if (oldRun.mode === "manual") {
                                retryManualSkills = await resolveManualSkillContext({ mode: "manual", skillIds: oldRun.skillIds }, undefined, projectId);
                            } else if (canAuto) {
                                retryAutoPlan = await prepareAutomaticSkillCatalog({ mode: "auto", skillIds: oldRun.skillIds }, undefined, prompt, projectId);
                            }
                        } catch (nextError) {
                            message.error(nextError instanceof Error ? nextError.message : String(nextError));
                            return;
                        }
                    } else {
                        message.error(error instanceof Error ? error.message : String(error));
                        return;
                    }
                }
            }

            setRunningNodeId(node.id);
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === node.id
                        ? {
                              ...item,
                              metadata: {
                                  ...item.metadata,
                                  status: NODE_STATUS_LOADING,
                                  errorDetails: undefined,
                                  images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_LOADING, errorDetails: undefined } : image)),
                              },
                          }
                        : item,
                ),
            );
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    if (controller.signal.aborted) return;
                    const baseMessages = buildNodeResponseMessages({ ...context, prompt: extractSkillMentions(prompt).text });
                    const messages = retryManualSkills ? withManualSkillMessages(baseMessages, retryManualSkills)
                        : retryAutoPlan ? withAutomaticSkillCatalog(baseMessages, retryAutoPlan) : baseMessages;
                    const autoRun = retryAutoPlan?.createRun();
                    let toolStarted = false;
                    let toolUnsupported = false;
                    let streamed = "";
                    const onDelta = (text: string) => {
                        streamed = text;
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                    };
                    let answer: string;
                    try {
                        answer = await requestImageQuestion(generationConfig, messages, onDelta, {
                            signal: controller.signal,
                            ...(autoRun ? { agent: {
                                tools: autoRun.tools, executeTool: autoRun.executeTool,
                                maxToolRounds: 6, maxToolCalls: 12, maxToolOutputChars: 32768,
                                onEvent: (event) => {
                                    if (event.type === "tool_start") toolStarted = true;
                                    autoRun.onEvent(event);
                                },
                            } } : {}),
                        });
                        if (autoRun) rememberSupportedSkillTools(generationConfig);
                    } catch (error) {
                        if (!autoRun || toolStarted || controller.signal.aborted || !isUnsupportedSkillToolsError(error)) throw error;
                        rememberUnsupportedSkillTools(generationConfig);
                        toolUnsupported = true;
                        answer = await requestImageQuestion(generationConfig, baseMessages, onDelta, { signal: controller.signal });
                    }
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? {
                        ...item, type: CanvasNodeType.Text,
                        metadata: { ...item.metadata, content: answer || streamed, prompt,
                            skillRun: toolUnsupported ? undefined : autoRun?.snapshot() || retryManualSkills?.snapshot,
                            skillTrace: toolUnsupported ? undefined : autoRun?.trace(),
                            skillMetrics: toolUnsupported ? undefined : autoRun?.metrics(),
                            status: NODE_STATUS_SUCCESS,
                        },
                    } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const retryContext = context || { referenceImages: retryImages, referenceVideos: [], referenceAudios: [] };
                    const request = node.metadata?.videoRequest || {
                        ...makeVideoGenerationRequest(generationConfig, prompt, generationConfig.model, retryContext, node.metadata?.videoReferences || []),
                    };
                    let generationTask: VideoGenerationTask | null = null;
                    const generatedVideo = await requestVideoGeneration(generationConfig, prompt, retryImages, {
                        signal: controller.signal,
                        request,
                        onTaskCreated: (task) => {
                            generationTask = task;
                            persistVideoTask(node.id, task);
                        },
                        onTaskStatus: (status) => generationTask && persistVideoTask(node.id, { ...generationTask, status }, status),
                    });
                    const video = await storeGeneratedVideo(generatedVideo);
                    const lastFrame = generatedVideo.lastFrameBlob ? await saveArkLastFrame(generatedVideo.lastFrameBlob) : undefined;
                    if (generationTask) persistVideoTask(node.id, generationTask, "succeeded");
                    const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                      metadata: {
                                          ...item.metadata,
                                          ...videoMetadata(video),
                                          prompt,
                                          model: generationConfig.model,
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          vquality: generationConfig.vquality,
                                          generateAudio: generationConfig.videoGenerateAudio,
                                          watermark: generationConfig.videoWatermark,
                                          videoMode: generationConfig.videoMode,
                                          videoRatio: generationConfig.videoRatio,
                                          returnLastFrame: generationConfig.videoReturnLastFrame,
                                          videoReferences: request.references.map(({ id, kind, role, storageKey, url, mimeType, durationMs, bytes }) => ({ id, kind, role, storageKey, url, mimeType, durationMs, bytes })),
                                          ...(generationTask ? { videoTask: { provider: generationTask.provider, channelId: generationTask.channelId, model: generationTask.model, taskId: generationTask.id, startedAt: generationTask.startedAt || Date.now(), status: "succeeded" as const } } : {}),
                                          ...(generatedVideo.lastFrameUrl ? { lastFrameUrl: generatedVideo.lastFrameUrl } : {}),
                                          ...(lastFrame ? { lastFrame } : {}),
                                      },
                                  }
                                : item,
                        ),
                    );
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal }), generationConfig.audioFormat);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    return;
                }

                const image = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, undefined, { signal: controller.signal }).then((items) => items[0])
                    : await requestGeneration(generationConfig, prompt, { signal: controller.signal }).then((items) => items[0]);
                const uploadedImage = await uploadImage(image.dataUrl);
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const retryImage: CanvasNodeImage = {
                    id: imageId || node.metadata?.primaryImageId || nanoid(),
                    status: NODE_STATUS_SUCCESS,
                    content: uploadedImage.url,
                    storageKey: uploadedImage.storageKey,
                    naturalWidth: uploadedImage.width,
                    naturalHeight: uploadedImage.height,
                    bytes: uploadedImage.bytes,
                    mimeType: uploadedImage.mimeType,
                };
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) => {
                        if (item.id !== node.id) return item;
                        const makePrimary = !imageId || !item.metadata?.content;
                        const edge = imageId ? Math.max(item.width, item.height) : 0;
                        const imageSize =
                            imageId && item.metadata?.freeResize
                                ? { width: item.width, height: item.height }
                                : imageId
                                  ? fitNodeSize(uploadedImage.width, uploadedImage.height, edge, edge)
                                  : fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                        return {
                            ...item,
                            type: CanvasNodeType.Image,
                            ...(makePrimary
                                ? { width: imageSize.width, height: imageSize.height, ...(imageId ? { position: { x: item.position.x + item.width / 2 - imageSize.width / 2, y: item.position.y + item.height / 2 - imageSize.height / 2 } } : {}) }
                                : {}),
                            metadata: {
                                ...item.metadata,
                                ...(makePrimary ? imageMetadata(uploadedImage) : { status: NODE_STATUS_SUCCESS }),
                                images: item.metadata?.images?.map((current) => (current.id === retryImage.id ? retryImage : current)),
                                primaryImageId: makePrimary ? retryImage.id : item.metadata?.primaryImageId,
                                prompt,
                                ...generationMetadata,
                            },
                        };
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: isResumableSeedanceProvider(item.metadata?.videoTask?.provider) && item.metadata.videoTask.status === "succeeded" ? NODE_STATUS_ERROR : item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: isResumableSeedanceProvider(item.metadata?.videoTask?.provider) && item.metadata.videoTask.status === "succeeded" ? errorDetails : item.metadata?.content ? undefined : errorDetails,
                                      ...(isResumableSeedanceProvider(item.metadata?.videoTask?.provider) && item.metadata.videoTask.status === "succeeded" ? { videoDownloadError: errorDetails } : {}),
                                      images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)),
                                  },
                              }
                            : item,
                    ),
                );
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, modal, openConfigDialog, projectId, startGenerationRequest, t],
    );

    const deleteBatchImage = useCallback((nodeId: string, imageId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if ((node?.metadata?.images?.length || 0) <= 2) setExpandedImageNodeIds((current) => new Set([...current].filter((id) => id !== nodeId)));
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const images = item.metadata?.images?.filter((image) => image.id !== imageId) || [];
                return { ...item, metadata: { ...item.metadata, images, count: images.length, primaryImageId: item.metadata?.primaryImageId === imageId ? images[0]?.id : item.metadata?.primaryImageId } };
            }),
        );
    }, []);

    const retryBatchImage = useCallback((node: CanvasNodeData, imageId: string) => void handleRetryNode(node, imageId), [handleRetryNode]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, t],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        async (payload: InsertAssetPayload) => {
            try {
                if (payload.kind === "text") {
                    insertAssistantText(payload.content, payload.title);
                } else if (payload.kind === "video") {
                    // Assets may still live in the legacy Asset library. Ingest
                    // explicitly when INSERTING into the SQLite-owned canvas.
                    const original = payload.storageKey && !isCanvasCasKey(payload.storageKey)
                        ? await getMediaBlob(payload.storageKey) : null;
                    const media = payload.storageKey && isCanvasCasKey(payload.storageKey)
                        ? { storageKey: payload.storageKey, url: canvasCasUrl(payload.storageKey)!, width: payload.width, height: payload.height }
                        : await uploadCanvasMedia(original || payload.url, "video");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                    const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                    const nextSize = fitNodeSize(media.width || spec.width, media.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) => [...prev, {
                        id, type: CanvasNodeType.Video, title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width, height: nextSize.height,
                        metadata: { content: media.url, storageKey: media.storageKey, status: NODE_STATUS_SUCCESS,
                            naturalWidth: media.width, naturalHeight: media.height },
                    }]);
                    setSelectedNodeIds(new Set([id]));
                } else {
                    const original = payload.storageKey && !isCanvasCasKey(payload.storageKey)
                        ? await getImageBlob(payload.storageKey) : null;
                    const image = payload.storageKey && isCanvasCasKey(payload.storageKey)
                        ? { storageKey: payload.storageKey, url: canvasCasUrl(payload.storageKey)! }
                        : await uploadImage(original || payload.dataUrl);
                    await insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title,
                        dataUrl: image.url, storageKey: image.storageKey });
                }
                setAssetPickerOpen(false);
            } catch (error) {
                message.error("导入画布媒体失败，未写入节点："+String(error));
            }
        },
        [insertAssistantImage, insertAssistantText, message, screenToCanvas, size.height, size.width],
    );

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData, imageId?: string) => {
        setPreviewNodeId(node.id);
        setPreviewImageId(imageId || null);
    }, []);
    const handleNodeRetry = useCallback((node: CanvasNodeData) => void handleRetryNode(node), [handleRetryNode]);
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);


    const monitorSqliteJob=useCallback((jobId:string)=>{
        if(sqliteJobWatchesRef.current.has(jobId))return;
        const controller=new AbortController();
        sqliteJobWatchesRef.current.set(jobId,controller);
        let lastSkillRound=-1;
        let recentText="";
        const progressKey="sqlite-text-"+jobId;
        void watchSqliteComfyJob({
            projectId,jobId,signal:controller.signal,
            getLocalGraph:()=>({nodes:nodesRef.current,connections:connectionsRef.current}),
            applyGraph:graph=>{
                if(activeProjectIdRef.current!==projectId||!pageMountedRef.current)return;
                nodesRef.current=graph.nodes;connectionsRef.current=graph.connections;
                setNodes(graph.nodes);setConnections(graph.connections);
            },
            onTextDelta:delta=>{
                if(controller.signal.aborted||activeProjectIdRef.current!==projectId)return;
                recentText=(recentText+delta).slice(-512);
                message.open({key:progressKey,type:"loading",duration:0,
                    content:"文本生成中："+recentText.slice(-120)});
            },
            onSkillText:(delta,round)=>{
                if(controller.signal.aborted||activeProjectIdRef.current!==projectId)return;
                if(round!==lastSkillRound){recentText="";lastSkillRound=round;}
                recentText=(recentText+delta).slice(-512);
                message.open({key:progressKey,type:"loading",duration:0,
                    content:"Skill 第 "+(round+1)+" 轮模型响应："+recentText.slice(-120)});
            },
            onSkillTool:event=>{
                if(controller.signal.aborted||activeProjectIdRef.current!==projectId)return;
                message.open({key:progressKey,type:"loading",duration:0,
                    content:"Skill "+event.name+"："+(event.status==="completed"?"已完成":"执行中")});
            },
            onStatus:(status,details)=>{
                if(controller.signal.aborted||activeProjectIdRef.current!==projectId)return;
                if(["succeeded","failed","cancelled","submission_unknown","blocked_credential","materialized","blocked","unavailable","needs_refresh"].includes(status))
                    message.destroy(progressKey);
                if(["succeeded","failed","cancelled","submission_unknown","blocked_credential"].includes(status)){
                    for(const [sourceId,activeJobId] of sqliteGenerationJobsRef.current){
                        if(activeJobId!==jobId)continue;
                        sqliteGenerationJobsRef.current.delete(sourceId);
                        setRunningNodeId(current=>current===sourceId?null:current);
                    }
                }
                if(status==="materialized")message.success("任务产物已写入画布");
                else if(status==="blocked"||status==="unavailable"||status==="needs_refresh")
                    message.warning("后端任务产物需要检查或刷新画布："+(details??status));
                else if(status==="failed"||status==="cancelled")
                    message.error("后端任务："+status);
            }
        }).finally(()=>{
            message.destroy(progressKey);
            if(sqliteJobWatchesRef.current.get(jobId)===controller)
                sqliteJobWatchesRef.current.delete(jobId);
        });
    },[message,projectId]);

    useEffect(()=>{monitorSqliteJobRef.current=monitorSqliteJob},[monitorSqliteJob]);

    // A route change must never carry another project’s cancel target.
    useEffect(()=>{sqliteGenerationJobsRef.current.clear()},[projectId]);

    // Refreshing the page must recover already-submitted jobs from SQLite,
    // including succeeded jobs whose materialization has not completed.
    useEffect(()=>{
        if(!projectLoaded)return;
        let cancelled=false;
        void canvasApi<{jobs:Array<{id:string;projectId:string|null;targetNodeId?:string|null;status:string;modelKind?:string}>}>(
            "/api/v1/jobs/snapshot"
        ).then(snapshot=>{
            if(cancelled)return;
            const active=snapshot.jobs.filter(job=>job.projectId===projectId&&
                !["succeeded","failed","cancelled"].includes(job.status));
            // Restore cancel actions after reload from authoritative SQLite,
            // not browser storage. Running cloud tasks may report not queued.
            for(const job of active){
                if(job.modelKind!=="video"||!job.targetNodeId||
                  !nodesRef.current.some(node=>node.id===job.targetNodeId))continue;
                sqliteGenerationJobsRef.current.set(job.targetNodeId,job.id);
                setRunningNodeId(current=>current??job.targetNodeId!);
            }
            // A historical succeeded task may still await Materializer, but do
            // not start thousands of pollers for completed lifetime history.
            const recent=snapshot.jobs.filter(job=>job.projectId===projectId&&
                job.status==="succeeded"&&
                !nodesRef.current.some(node=>node.metadata?.comfyArtifact?.runId===job.id||node.metadata?.modelArtifact?.jobId===job.id))
                .slice(-40);
            for(const job of [...active,...recent])monitorSqliteJob(job.id);
        }).catch(()=>{});
        return ()=>{cancelled=true};
    },[projectLoaded,monitorSqliteJob,projectId]);

    // Both the node toolbar and inspector submit through one durable path.
    // A synchronous per-node lock covers template lookup, staging and the HTTP request.

    // One SQLite JobCoordinator path for toolbar and inspector. No V2 fallback.
    const executeComfyWorkflow=useCallback(async(nodeId:string):Promise<ComfyRunState>=>{
        const key=projectId+":"+nodeId;
        if(comfyExecuteLocksRef.current.has(key))
            throw new Error("该工作流正在提交，请勿重复点击");
        comfyExecuteLocksRef.current.add(key);
        try{
            if(!projectLoaded)throw new Error("画布尚未加载完成");
            if(!globalComfyInstanceId)throw new Error("请先在全局 ComfyUI 设置中选择默认实例");
            if(!backendComfyEnabled)
                throw new Error("任务调度服务不可用：请启动并配置本地 ComfyUI 后端；不会回退旧 V2 执行");
            const snapshot={nodes:nodesRef.current,connections:connectionsRef.current};
            const workflowNode=snapshot.nodes.find(node=>node.id===nodeId);
            if(!workflowNode||workflowNode.type!==COMFY_WORKFLOW_MOCK_TYPE)
                throw new Error("工作流节点不存在");
            const binding=workflowNode.metadata?.comfyWorkflow;
            if(!binding?.templateId||!binding.templateRevision)
                throw new Error("请先在工作流参数面板绑定预设模板");
            const template=await getComfyTemplate(binding.templateId,binding.templateRevision);
            if(!template)throw new Error("绑定的工作流模板版本不存在");
            const outputs=template.ports.filter(port=>port.direction==="source"&&
                !!port.capture?.adapterId&&port.capture.kind!=="none");
            if(!outputs.length)throw new Error("工作流没有可捕获的输出端口");
            if(activeProjectIdRef.current!==projectId||!pageMountedRef.current)
                throw new Error("画布已切换，停止提交");
            const bridge=createSqliteComfyBridge({
                projectId,getLocalGraph:()=>({nodes:nodesRef.current,connections:connectionsRef.current})
            });
            const job=await startBackendComfyWorkflowRun({
                bridge,projectId,workflowNode,...snapshot,template,
                instanceId:globalComfyInstanceId,outputPortIds:outputs.map(port=>port.id),
                serverAuthoritative:true
            });
            if(activeProjectIdRef.current===projectId&&pageMountedRef.current){
                message.info("生成任务已提交："+job.id+"。完成后自动恢复产物节点。");
                monitorSqliteJob(job.id);
            }
            return {runId:job.id,status:job.status,workflowNodeId:nodeId,artifacts:[]};
        }finally{comfyExecuteLocksRef.current.delete(key)}
    },[backendComfyEnabled,globalComfyInstanceId,message,monitorSqliteJob,projectId,projectLoaded]);


    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            panelNode.type === CanvasNodeType.Director ? null : panelNode.type === COMFY_WORKFLOW_MOCK_TYPE ? (
                <Suspense fallback={<div className="rounded-xl p-4">正在加载工作流参数…</div>}>
                    <ComfyWorkflowInstancePanel
                        node={panelNode}
                        connections={connections}
                        onExecute={() => executeComfyWorkflow(panelNode.id)}
                        backendExecution={backendComfyEnabled}
                        projectId={projectId}
                        onExecutionChange={(execution)=>handleConfigNodeChange(panelNode.id,{comfyExecution:execution})}
                        comfyInstanceId={globalComfyInstanceId}
                        onChange={(patch) => handleConfigNodeChange(panelNode.id, patch)}
                        onTemplateChange={(patch) => {
                            const candidate = applyNodeConfigPatch(panelNode, patch);
                            const candidateNodes = nodesRef.current.map((n) => n.id === panelNode.id ? candidate : n);
                            const errors = validateCanvasPortConnections(candidateNodes, connectionsRef.current);
                            if (errors.length) {
                                message.error("Template ports conflict with existing connections: " + errors[0].error);
                                return false;
                            }
                            handleConfigNodeChange(panelNode.id, patch);
                            return true;
                        }}
                        onClose={() => setDialogNodeId(null)}
                    />
                </Suspense>
            ) : panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    nodeId={panelNode.id}
                    projectId={projectId}
                    value={panelNode.metadata?.generationMode === "text"
                        ? showLegacySkillMentions(panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? "", panelNode.metadata?.skillBinding)
                        : panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    enableSkills={panelNode.metadata?.generationMode === "text"}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, panelNode.metadata?.skillBinding?.mode === "manual"
                        ? { composerContent, skillBinding: { mode: "off", skillIds: [] } }
                        : { composerContent })}
                    onClose={() => setDialogNodeId(null)}
                />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    projectId={projectId}
                    isRunning={runningNodeId === panelNode.id}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onStop={confirmStopGeneration}
                    modeOverride={getNodeDefinition(panelNode.type)?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            ),
        [backendComfyEnabled,confirmStopGeneration, connections, executeComfyWorkflow, globalComfyInstanceId, handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, message, projectId, runningNodeId],
    );

    const handleDirectorExport = useCallback(
        (directorNodeId: string) => async (kind: "image" | "video", blob: Blob) => {
            const director = nodesRef.current.find((node) => node.id === directorNodeId);
            const base = director?.position || getCanvasCenter();
            const offset = { x: base.x + (director?.width || 340) + 32, y: base.y };
            const node = createCanvasNode(kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video, offset);
            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            try {
                if (kind === "image") {
                    const image = await uploadImage(blob);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, width: image.width, height: image.height, metadata: { ...item.metadata, ...imageMetadata(image) } } : item)));
                } else {
                    const video = await uploadMediaFile(blob, "director");
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, width: video.width || 420, height: video.height || 236, metadata: { ...item.metadata, ...videoMetadata(video) } } : item)));
                }
            } catch {
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: "error" } } : item)));
            }
        },
        [getCanvasCenter],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) => (
            <CanvasConfigNodePanel
                node={contentNode}
                isRunning={runningNodeId === contentNode.id}
                onConfigChange={handleConfigNodeChange}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onStop={confirmStopGeneration}
                onGenerate={(nodeId) => {
                    const target = nodesRef.current.find((item) => item.id === nodeId);
                    void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                }}
            />
        ),
        [confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, runningNodeId],
    );

    // Grouped so NodeLayer's prop list stays readable. The node still receives each entry as its own
    // prop, so an entry that changes identity only re-renders the nodes it actually affects.
    const sharedNodeProps = useMemo<SharedNodeProps>(() => ({ viewportRef, renderPanel: renderNodePanel, renderNodeContent: renderNodeContentPanel }), [renderNodeContentPanel, renderNodePanel]);

    // Rebuilt every render on purpose: CanvasActionsProvider only reads it through a ref, so the
    // identity that reaches consumers stays stable no matter how often these callbacks change.
    const canvasActions: CanvasActions = {
        onMouseDown: handleNodeMouseDown,
        onSelectCapture: handleNodeSelectCapture,
        onHoverStart: handleNodeHoverStart,
        onHoverEnd: handleNodeHoverEnd,
        onConnectStart: handleConnectStart,
        onResizeStart: handleNodeResizeStart,
        onResize: handleNodeResize,
        onImageDimensions: handleGeneratedImageDimensions,
        onVideoDimensions: handleGeneratedVideoDimensions,
        onResizeEnd: handleNodeResizeEnd,
        onContentChange: handleNodeContentChange,
        onTitleChange: handleNodeTitleChange,
        onContextMenu: handleNodeContextMenu,
        onToggleBatch: toggleBatchExpanded,
        onSetBatchPrimary: setBatchPrimary,
        onDuplicateBatchImage: duplicateBatchImage,
        onRetryBatchImage: retryBatchImage,
        onDeleteBatchImage: deleteBatchImage,
        onRetry: handleNodeRetry,
        onGenerateImage: generateImageFromTextNode,
        onViewImage: handleNodeViewImage,
    };

    if (!projectLoaded) return projectLoadError||backendSaveError ? <div className="flex h-full items-center justify-center gap-3 p-8">本地后端不可用：{projectLoadError||backendSaveError}<Button onClick={()=>{void loadProjects().then(()=>setProjectLoadAttempt(n=>n+1)).catch(error=>setProjectLoadError(String(error)))}}>重试</Button></div> : <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasPerfBridge containerRef={containerRef} viewport={viewport} setViewport={setViewport} selectedNodeIds={selectedNodeIds} nodes={nodes} connections={connections} />
            <CanvasSidePanel nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onInsertAsset={handleAssetInsert} />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                {backendSaveError?<div role="alert" className="absolute right-4 top-16 z-[100] rounded-lg border border-red-500 bg-background p-3 text-sm shadow-lg">
                    画布自动保存失败：{backendSaveError}
                    <Button size="small" className="ml-2" onClick={()=>{void awaitCanvasStorePersistence().catch(error=>message.error(String(error)))}}>重试保存</Button>
                </div>:null}
                <CanvasTopBar
                    title={currentProjectTitle || t("canvas.projectPage.untitledCanvas")}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={()=>{void awaitCanvasStorePersistence(projectId).then(()=>navigate("/")).catch(error=>message.error("未保存，无法离开："+String(error)))}}
                    onProjects={()=>{void awaitCanvasStorePersistence(projectId).then(()=>navigate("/canvas")).catch(error=>message.error("未保存，无法离开："+String(error)))}}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onExportProject={()=>message.warning("完整项目导出将在媒体后端化阶段开放")}
                    onImportImage={() => handleUploadRequest()}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onOpenJobHistory={()=>setJobHistoryOpen(true)}
                />

                <CanvasJobHistory projectId={projectId} open={jobHistoryOpen}
                    onClose={()=>setJobHistoryOpen(false)}
                    onObserveJob={jobId=>monitorSqliteJobRef.current(jobId)}
                    onRefreshCanvas={()=>refreshSqliteComfyArtifacts({
                        projectId,
                        getLocalGraph:()=>({nodes:nodesRef.current,connections:connectionsRef.current}),
                        applyGraph:graph=>{
                            if(activeProjectIdRef.current!==projectId||!pageMountedRef.current)return;
                            nodesRef.current=graph.nodes;connectionsRef.current=graph.connections;
                            setNodes(graph.nodes);setConnections(graph.connections);
                        }
                    })}
                />

                <AtelierCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    tool={canvasTool}
                    backgroundMode={backgroundMode}
                    onViewportChange={handleViewportChange}
                    onWheelActivityChange={setIsWheelZooming}
                    onPanActivityChange={setIsCanvasPanning}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <ConnectionLayer
                        connections={visibleConnections}
                        scale={viewport.k}
                        nodeById={nodeById}
                        selectedConnectionId={selectedConnectionId}
                        relatedConnectionIds={relatedHighlight.connectionIds}
                        onSelect={handleConnectionSelect}
                        onContextMenu={handleConnectionContextMenu}
                        onDelete={deleteConnection}
                    />

                    <ActiveConnectionOverlay connectingParams={connectingParams} mouseWorld={mouseWorld} connectionTargetNodeId={connectionTargetNodeId} nodeById={nodeById} />

                    {/* Panels rendered inside a node's DOM read the graph through this context,
                        instead of the controller precomputing references and generation inputs for
                        every node on every change. */}
                    <CanvasActionsProvider actions={canvasActions}>
                        <CanvasGraphIndexProvider index={graphIndex}>
                            <NodeLayer
                                nodes={visibleNodes}
                                wheelZoomActive={isWheelZooming}
                                scale={viewport.k}
                                // Only promotion ordering needs the center. Freeze it while
                                // gestures pause promotion so ordinary pans cannot invalidate
                                // every memoized NodeLayer child.
                                centerX={isCanvasPanning || isNodeDragging || isNodeResizing || Boolean(selectionBox) || isWheelZooming || Boolean(connectingParams) ? 0 : (size.width / 2 - viewport.x) / viewport.k}
                                centerY={isCanvasPanning || isNodeDragging || isNodeResizing || Boolean(selectionBox) || isWheelZooming || Boolean(connectingParams) ? 0 : (size.height / 2 - viewport.y) / viewport.k}
                                pausePromotions={isCanvasPanning || isNodeDragging || isNodeResizing || Boolean(selectionBox) || isWheelZooming || Boolean(connectingParams)}
                                shared={sharedNodeProps}
                                selectedNodeIds={selectedNodeIds}
                                relatedNodeIds={relatedHighlight.nodeIds}
                                activeNodeId={activeNodeId}
                                connectionTargetNodeId={connectionTargetNodeId}
                                isConnecting={Boolean(connectingParams)}
                                panelNodeId={dialogNodeId}
                                isNodeResizing={isNodeResizing}
                                isMarqueeActive={Boolean(selectionBox)}
                                dropTargetGroupId={dropTargetGroupId}
                                expandedImageNodeIds={expandedImageNodeIds}
                                showImageInfo={showImageInfo}
                                groupChildCountById={groupChildCountById}
                            />
                        </CanvasGraphIndexProvider>
                    </CanvasActionsProvider>

                    <SelectionOverlay selectionBox={selectionBox} scale={viewport.k} />
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} canvasRef={containerRef} viewport={viewport} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            canvasRef={containerRef}
                            viewport={viewport}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </AtelierCanvas>

                {directorPanelNode ? <DirectorPanel nodeId={directorPanelNode.id} open onClose={() => setDialogNodeId(null)} onExport={handleDirectorExport(directorPanelNode.id)} /> : null}

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || expandedImageNodeIds.has(toolbarNode?.id || "") ? null : toolbarNode}
                    viewport={viewport}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onExecuteComfy={(node) => void executeComfyWorkflow(node.id).catch((cause) => message.error("工作流执行失败："+(cause instanceof Error?cause.message:String(cause))))}
                    comfyExecuteDisabled={!projectLoaded || !globalComfyInstanceId || (toolbarNode?.id?comfyExecuteLocksRef.current.has(projectId+":"+toolbarNode.id):false)}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onCaptureVideoFrame={(node) => { videoFrameIdentityRef.current = `${projectId}:${node.id}:${node.metadata?.storageKey || ""}:${node.metadata?.content || ""}`; setVideoFrameNodeId(node.id); }}
                    onTrimAudio={(node) => { audioTrimIdentityRef.current = `${projectId}:${node.id}:${node.metadata?.storageKey || ""}:${node.metadata?.content || ""}`; document.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => { if (element.dataset.nodeId === node.id) element.querySelector("audio")?.pause(); }); setAudioTrimNodeId(node.id); }}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={handleNodeViewImage}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                />

                <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canGroupSelected={canGroupSelectedNodes}
                    canvasTool={canvasTool}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddAudio={() => createNode(CanvasNodeType.Audio)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddConfig={() => createNode(CanvasNodeType.Config)}
                    onAddGroup={() => createNode(CanvasNodeType.Group)}
                    onGroupSelected={groupSelectedNodes}
                    onAddDirector={() => createNode(CanvasNodeType.Director)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onCanvasToolChange={setCanvasTool}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={handleViewportChange} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onFitView={fitViewport} canFocusSelected={nodes.some((node) => selectedNodeIds.has(node.id))} onFocusSelected={focusSelectedNodes} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        onClose={() => setContextMenu(null)}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />

                {videoFrameNode ? <CanvasVideoFrameDialog key={`${projectId}:${videoFrameNode.id}:${videoFrameNode.metadata?.storageKey || ""}:${videoFrameNode.metadata?.content || ""}`} node={videoFrameNode} open onClose={() => setVideoFrameNodeId(null)} onCapture={(blob, timeMs) => captureVideoFrame(videoFrameNode, blob, timeMs)} /> : null}

                {audioTrimNode ? <CanvasAudioTrimDialog key={`${projectId}:${audioTrimNode.id}:${audioTrimNode.metadata?.storageKey || ""}:${audioTrimNode.metadata?.content || ""}`} node={audioTrimNode} open onClose={() => setAudioTrimNodeId(null)} onTrim={(blob, startMs, endMs, durationMs, signal) => trimAudioNode(audioTrimNode, blob, startMs, endMs, durationMs, signal)} /> : null}

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                <Modal title={t("canvas.projectPage.superResolve")} open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">{t("canvas.projectPage.notImplemented")}</div>
                </Modal>

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                <Modal
                    title={t("canvas.projectPage.imageDetails")}
                    open={Boolean(previewContent)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewContent ? <img src={previewContent} alt={previewNode?.title || t("assets.kinds.image")} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} /> : null}
                </Modal>

                <Modal
                    title={t("canvas.projectPage.clearTitle")}
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.projectPage.clear")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">{t("canvas.projectPage.clearDescription")}</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
        </main>
    );
}

function findVideoFramePosition(source: CanvasNodeData, size: { width: number; height: number }, nodes: CanvasNodeData[]): Position {
    const gap = 24;
    const x = source.position.x + source.width + 96;
    let y = source.position.y;
    for (let attempt = 0; attempt < nodes.length + 1; attempt += 1) {
        const collisions = nodes.filter((node) => node.type !== CanvasNodeType.Group && x < node.position.x + node.width + gap && x + size.width + gap > node.position.x && y < node.position.y + node.height + gap && y + size.height + gap > node.position.y);
        if (!collisions.length) return { x, y };
        y = Math.max(...collisions.map((node) => node.position.y + node.height + gap));
    }
    return { x, y };
}
