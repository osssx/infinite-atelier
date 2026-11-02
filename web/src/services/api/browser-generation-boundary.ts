/** Runtime fence for legacy API entry points retained for import compatibility. */
export function isBrowserGenerationDisabled():boolean{return true;}
export const browserGenerationError=(operation:string)=>
 new Error(`${operation}只能通过画布后端 JobCoordinator 执行；此浏览器接口不会发起生成请求。`);
