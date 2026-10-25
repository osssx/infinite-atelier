/** Planned Fastify wire DTOs (P0); existing browser stores and Comfy gateway remain active. */
export type JobExecutionMode="immediate"|"stream"|"poll";
export type JobStatus="queued"|"preparing"|"submitting"|"running"|"collecting"|"succeeded"|"failed"|"cancelled"|"submission_unknown"|"blocked_credential";
export type BackendArtifactKind="image"|"video"|"audio"|"text";
export type BackendErrorResponse={code:string;message:string;requestId:string;details?:unknown};
/** The local launcher exchanges a single-use token; never put it in a browser URL. */
export type LocalSessionResponse={csrfToken:string;expiresAt:number};
export type BlobUploadResponse={blobId:string;sha256:string;byteSize:number;mimeType:string;existing:boolean};
export type BackendBlobMime="image/png"|"image/jpeg"|"image/webp"|"video/mp4"|"video/webm"|"audio/wav"|"audio/flac"|"audio/ogg"|"audio/mpeg"|"text/plain";

export type BackendJobSnapshot={
 jobId:string;idempotencyKey:string;requestFingerprint:string;executionMode:JobExecutionMode;
 projectId?:string;targetNodeId?:string;expectedProjectRevision?:number;sourceNodeFingerprint?:string;
 secretVersionRef:string;adapterVersion:string;modelSnapshot:Record<string,unknown>;
 frozenInputs:readonly {blobId:string;sha256:string}[];options:Record<string,unknown>;
};
export type BackendJobEvent={eventId:number;jobId:string;kind:string;timestamp:number;payload:unknown};
export type BackendJobsSnapshot={jobs:readonly {id:string;status:JobStatus;executionMode:JobExecutionMode}[];eventCursor:number};
export type BackendArtifact={
 artifactId:string;jobId:string;portId:string|null;itemKey:string;kind:BackendArtifactKind;
 blobId:string;sha256:string;mimeType:string;index?:number;
};
export type BackendComfyArtifactProvenance={
 runId:string;artifactId:string;workflowNodeId:string;portId:string;kind:BackendArtifactKind;index:number;
};
