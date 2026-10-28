/** Rendering/polling predicates shared by the canvas and Comfy inspector. */
const active=new Set(["submitting","queued","preparing","running","collecting","importing"]);
const terminal=new Set(["succeeded","failed","cancelled","submission_unknown","timed_out","import_failed","blocked_credential","unavailable"]);
export function isComfyRunActive(status?:string):boolean {return Boolean(status&&active.has(status));}
export function isComfyRunTerminal(status?:string):boolean {return Boolean(status&&terminal.has(status));}
export function comfyRunStatusLabel(status?:string):string {
    switch(status){
        case "submitting":return "提交工作流…";
        case "queued":return "排队中…";
        case "preparing":return "准备输入…";
        case "running":return "生成中…";
        case "collecting":return "回收图片…";
        case "importing":return "导入画布…";
        case "blocked_credential":return "凭据不可用";
        case "unavailable":return "任务状态暂不可用";
        case "succeeded":return "生成完成";
        case "failed":return "生成失败";
        case "cancelled":return "任务已取消";
        case "submission_unknown":return "提交结果待确认";
        case "timed_out":return "任务超时";
        case "import_failed":return "导入图片失败";
        default:return "已绑定工作流";
    }
}
