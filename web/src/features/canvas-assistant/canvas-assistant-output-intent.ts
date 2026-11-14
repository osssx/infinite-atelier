/** Explicit user instruction to return prose without mutating the canvas.
 * This is a conservative safety override, not general NLP intent recognition.
 * Keep the backend's fail-closed guard in assistant-action-intent.mjs aligned.
 */
export function isCanvasAssistantTextOnlyRequest(request:string):boolean{
 if(!request.trim())return false;
 return /(?:只|仅)(?:输出|回复|回答|返回|提供|给出|给我|展示|用|以)(?:[^\n。！？;；]{0,16})(?:文字|文本|方案|建议|分析|大纲)/.test(request)||
  /(?:不要|别|请勿|禁止|无需|不需要|不允许)(?:再|去|对|在|直接|进行|任何|自动|实际|擅自|修改|更改|操作|编辑){0,5}(?:修改|更改|操作|编辑|写入|执行)(?:任何|当前|现有|原有|整个|此|该)?画布(?:[\s，。、；;！!]|$)/.test(request)||
  /(?:不要|别|请勿|禁止|无需|不需要|不允许)(?:在|对)?画布(?:上|中)?(?:进行)?(?:修改|编辑|操作|更新|创建|添加|执行)(?:[^\n，。;；!?]{0,12})?(?:[\s，。、；;！!]|$)/.test(request);
}

/** A negative Skill instruction can cover a coordinated list:
 * "不要修改画布、调用 Skill 或提交生成".
 * No automatic Skill matching or script proposals for that turn.
 */
export function isCanvasAssistantSkillOptOutRequest(request:string):boolean{
 return /(?:不要|别|请勿|禁止|无需|不需要|不允许)[^\n。！？但]{0,50}(?:调用|使用|运行|执行)\s*skills?\b/i.test(request);
}
