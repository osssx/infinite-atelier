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


/** Only request structured canvas actions for an affirmative edit instruction.
 * Otherwise the request is a normal text conversation, including follow-up
 * story details in an existing cross-chat Task.
 * Keep the intent guard aligned with server/backend/assistant-action-intent.mjs.
 */
export function isCanvasAssistantCanvasActionRequest(request:string):boolean{
 const text=request.trim();
 if(!text||text.length>12000||isCanvasAssistantTextOnlyRequest(text))return false;
 // Inspect each instruction separately: nouns inside a read clause are not
 // edits, while a later affirmative connection/layout instruction remains one.
 const clauses=text.split(/[，,。；;\n]|(?:然后|之后|接着|随后|并且|同时|再|并(?=把|将|给|为|对|创建|新建|添加|删除|修改|更新|连接|连线|布局|排版|排列|执行|运行|生成))/).map(part=>part.trim()).filter(Boolean);
 const inspection=/^(?:请|麻烦|帮我|你能|先|\s)*(?:查看|查找|检索|搜索|查询|读取|列出|检查|定位|梳理)/;
 const edit=/(?:布局|排版|排列|整理(?:画布|节点|工作流)|创建|新建|添加|插入|连接|连线|删除|移除|修改|更新|替换|解散|分组|设置|配置|切换|执行|运行|生成|调整.*位置)/;
 if(clauses.some(part=>inspection.test(part))&&
  !clauses.some(part=>!inspection.test(part)&&edit.test(part)))return false;
 if(/^(?:(?:请|麻烦|帮我|你能)?(?:解释|介绍|分析|说明|讨论|比较|总结|评价)|如何|怎么|为什么|什么是|能否|能不能|可以吗|是否|要不要|如果|假设|假如|只需|只要|仅|先不)/.test(text))return false;
 if(/^(?:不要|别|请勿|禁止|先不要)|(?:不要执行|别执行|无需执行|不用操作|不需要执行|仅讨论|只回复|只分析|只要建议|只给建议|预览|假设|如果|建议如何|应该如何|怎么做|怎么办|是什么|会怎样|能否|可以吗|能不能|是否应该|模拟|演示|示例|给我.*建议)/.test(text))return false;
 return /(?:布局|排版|排列|整理(?:画布|节点|工作流)|创建|新建|添加|插入|连接|连线|删除|移除|修改|更新|替换|解散|分组|设置|配置|切换(?:[^\n]{0,24})?(?:模型|参数)|(?:执行|运行|生成)(?:节点|工作流|模型|图片|图像|视频|音频|文本|选中|当前)?|调整.*位置)/.test(text);
}
