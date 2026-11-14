/** User intent gate; does not replace the backend's Task/Turn read policy. */
export function wantsAssistantTaskReadTools(text:string,taskId?:string|null){
 return Boolean(taskId)&&
  /(?:查看|查找|检索|搜索|查询|读取|列出|检查|定位|梳理)/.test(text)&&
  /(?:画布|节点|连线|端口|任务(?:历史|步骤|记录)|创作(?:资料|历史)|角色(?:设定|资料|节点)|故事(?:设定|资料)|场景(?:资料|节点)|工作流(?:节点)?)/.test(text);
}
