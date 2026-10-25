/** Planned Fastify wire DTOs (P0); existing browser stores and Comfy gateway remain active. */
export type JobExecutionMode="immediate"|"stream"|"poll";
export type JobStatus="queued"|"preparing"|"submitting"|"running"|"collecting"|"succeeded"|"failed"|"cancelled"|"submission_unknown"|"blocked_credential";
export type BackendArtifactKind="image"|"video"|"audio"|"text";
export type BackendErrorResponse={code:string;message:string;requestId:string;details?:unknown};
/** The local launcher exchanges a single-use token; never put it in a browser URL. */
export type LocalSessionResponse={csrfToken:string;expiresAt:number};
export type BlobUploadResponse={blobId:string;sha256:string;byteSize:number;mimeType:string;existing:boolean};
export type BackendBlobMime="image/png"|"image/jpeg"|"image/webp"|"video/mp4"|"video/webm"|"video/x-matroska"|"audio/wav"|"audio/flac"|"audio/ogg"|"audio/mpeg"|"text/plain";


export type BackendChannelMetadata={
 id:string;provider:string;displayName:string;hasKey:boolean;
 keyVersion:string|null;createdAt:number;updatedAt:number;
};
export type BackendCredentialVersion={
 id:string;channelId:string;version:number;createdAt:number;revokedAt:number|null;
};
export type BackendChannelCreateRequest={
 id?:string;provider:string;displayName:string;apiKey:string;
};
export type BackendCredentialRotateRequest={apiKey:string;expectedKeyVersion:string|null};
export type BackendJobSnapshot={
 jobId:string;idempotencyKey:string;requestFingerprint:string;executionMode:JobExecutionMode;
 projectId?:string;targetNodeId?:string;expectedProjectRevision?:number;sourceNodeFingerprint?:string;
 channelId?:string;secretVersionRef?:string;adapterVersion:string;modelSnapshot:Record<string,unknown>;
 frozenInputs:readonly {blobId:string;sha256:string}[];options:Record<string,unknown>;
};

export type BackendJobAttempt={
 id:string;jobId:string;phase:string;upstreamTaskId:string|null;
 startedAt:number;finishedAt:number|null;outcome:string|null;
};
export type BackendJobView={
 id:string;projectId:string|null;status:JobStatus;executionMode:JobExecutionMode;
 createdAt:number;updatedAt:number;upstreamTaskId:string|null;
 attemptId:string|null;submitMarker:string|null;submissionStartedAt:number|null;
};
export type BackendJobEvent={eventId:number;jobId:string;kind:string;timestamp:number;payload:unknown};
export type BackendJobsSnapshot={jobs:readonly {id:string;status:JobStatus;executionMode:JobExecutionMode}[];eventCursor:number};
export type BackendArtifact={
 artifactId:string;jobId:string;portId:string|null;itemKey:string;kind:BackendArtifactKind;
 blobId:string;sha256:string;mimeType:string;index?:number;
 metadata?:{comfyArtifact?:BackendComfyArtifactProvenance;provenance?:Record<string,unknown>};
};
export type BackendComfyArtifactProvenance={
 runId:string;artifactId:string;workflowNodeId:string;portId:string;kind:BackendArtifactKind;index:number;
};
