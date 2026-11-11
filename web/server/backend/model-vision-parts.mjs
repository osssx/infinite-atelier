/** Shared multimodal user-part serialization for generated text and canvas assistant.
 * Callers validate/freeze image CAS before passing byte buffers here.
 */
export function openAiVisionContent(text,images,{detail}={}){
 return [{type:"text",text},...images.map(image=>({
  type:"image_url",image_url:{
   url:"data:"+image.mimeType+";base64,"+(image.bytes?
    Buffer.from(image.bytes).toString("base64"):image.data),
   ...(detail?{detail}:{})
  }
 }))];
}
export function geminiVisionParts(text,images){
 return [{text},...images.map(image=>({
  inlineData:{mimeType:image.mimeType,data:image.data??Buffer.from(image.bytes).toString("base64")}
 }))];
}
