export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
    Director = "director",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";
export type CanvasVideoReference = { id: string; kind: "image" | "video" | "audio"; role?: "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio"; storageKey?: string; url?: string; dataUrl?: string; mimeType?: string; durationMs?: number; bytes?: number; width?: number; height?: number };
export type CanvasVideoTask = { provider: "volcengine_ark" | "router_local" | "openai" | "plugin"; channelId?: string; model: string; taskId: string; startedAt: number; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired" };

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

export type CanvasNodeMetadata = {
    videoFrame?: { sourceNodeId: string; timeMs: number };
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    textCount?: number;
    /** User's selection on Config nodes, not automatically inherited by unrelated nodes. */
    skillBinding?: import("@/features/skills/types").SkillBinding;
    /** Immutable version snapshot attached to generated text for deterministic retries. */
    skillRun?: import("@/features/skills/skill-manual").AppliedSkillSnapshot | import("@/features/skills/skill-auto").AutoSkillSnapshot;
    /** Small, persisted read-only Skill tool audit summary, not intermediate model content. */
    skillTrace?: import("@/features/skills/skill-auto").SkillTraceEvent[];
    skillMetrics?: import("@/features/skills/skill-auto").SkillRunMetrics;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoMode?: "text_to_video" | "first_frame" | "first_last_frame" | "omni_reference";
    videoRatio?: string;
    returnLastFrame?: string;
    videoReferences?: CanvasVideoReference[];
    videoRequest?: Omit<import("@/services/api/video").VideoGenerationRequest, "references"> & { references: CanvasVideoReference[] };
    videoTask?: CanvasVideoTask;
    lastFrameUrl?: string;
    lastFrame?: { storageKey: string; url: string; width: number; height: number; bytes: number; mimeType: string };
    videoDownloadError?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    groupId?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
