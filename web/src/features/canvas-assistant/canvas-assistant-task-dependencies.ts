/** Plan only from server-verified receipts. Model messages are not evidence.
 * The newest verified Step is the immediate dependency; an unresolved
 * generation must first receive its own materialization receipt.
 */
export type AssistantTaskDependencyStep={
 id:string;planVersion:number;ordinal:number;kind:string;status:string;
 receiptTrust:string;dependsOn?:string[];
};
export function confirmedAssistantTaskDependencies(
 task:{status:string;activePlanVersion:number;steps?:AssistantTaskDependencyStep[]}
):string[]{
 if(["cancelled","completed","failed","blocked","cancelling","needs_reconcile"].includes(task.status))
  throw Error("assistant_task_not_editable");
 const steps=(task.steps??[]).filter(step=>step.planVersion===task.activePlanVersion)
  .sort((a,b)=>a.ordinal-b.ordinal);
 const pending=steps.find(step=>step.status!=="succeeded"||step.receiptTrust!=="server_committed");
 if(pending)throw Error("assistant_task_step_unverified:"+pending.id+
  "（"+pending.status+"）；请先在 Task 面板确认/对账，不能自动提交下一步");
 const materializations=steps.filter(step=>step.kind==="materialize");
 const notMaterialized=steps.find(step=>["model_job","comfy_workflow"].includes(step.kind)&&
  !materializations.some(mat=>mat.dependsOn?.includes(step.id)));
 if(notMaterialized)throw Error("assistant_task_materialization_required:"+notMaterialized.id+
  "；生成完成不等于已经落图，请先对账");
 return steps.length?[steps[steps.length-1].id]:[];
}
