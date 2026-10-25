/** P0: isolated runtime contract, not yet wired to the current Comfy gateway. */
export const EXECUTION_MODES=Object.freeze(["immediate","stream","poll"]);
export const JOB_STATUSES=Object.freeze(["queued","preparing","submitting","running","collecting","succeeded","failed","cancelled","submission_unknown","blocked_credential"]);
export const ARTIFACT_KINDS=Object.freeze(["image","video","audio","text"]);
const edges={
 queued:["preparing","cancelled","blocked_credential"],
 preparing:["queued","submitting","failed","cancelled","blocked_credential"],
 submitting:["running","collecting","failed","submission_unknown","blocked_credential"],
 running:["collecting","failed","cancelled","submission_unknown","blocked_credential"],
 collecting:["succeeded","failed","blocked_credential"],
 submission_unknown:["running","collecting","failed"],
 blocked_credential:["running","collecting","failed","cancelled"],
 succeeded:[],failed:[],cancelled:[]
};
export function assertJobTransition(from,to,{executionMode,confirmedNotAccepted=false,trustedRemoteMatch=false,recoveryCredentialAuthorized=false}={}){
 if(!EXECUTION_MODES.includes(executionMode))throw Error("invalid_execution_mode");
 if(!JOB_STATUSES.includes(from)||!JOB_STATUSES.includes(to))throw Error("invalid_job_status");
 if(!edges[from].includes(to))throw Error("illegal_job_transition");
 if(to==="running"&&executionMode==="immediate")throw Error("immediate_cannot_poll");
 if(from==="submitting"&&["failed","blocked_credential"].includes(to)&&!confirmedNotAccepted)throw Error("submission_may_have_occurred");
 if(from==="submission_unknown"&&["running","collecting"].includes(to)&&!trustedRemoteMatch)throw Error("unverified_remote_task");
 if(from==="blocked_credential"&&["running","collecting"].includes(to)&&(!trustedRemoteMatch||!recoveryCredentialAuthorized))throw Error("credential_recovery_not_authorized");
 return true;
}
export function classifySubmissionFailure({confirmedNotAccepted=false}={}){
 return confirmedNotAccepted?"failed":"submission_unknown";
}
export function credentialRecoveryPolicy({submissionMayHaveOccurred,trustedRemoteTaskId}){
 if(trustedRemoteTaskId)return "resume_existing_task_only";
 return submissionMayHaveOccurred?"reconcile_or_explicit_new_job":"new_linked_job_required";
}
