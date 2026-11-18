const kindLabels={image:"图片",video:"视频",audio:"音频",text:"文本"};

export function generatedNodeTitle(db,{nodes,source,kind,jobId,isComfy=false}){
 const sourceTitle=typeof source?.title==="string"?source.title.trim().replace(/\s+/gu," "):"";
 const characters=Array.from(sourceTitle);
 let name=characters.length>32?characters.slice(0,31).join("")+"…":sourceTitle;
 if(!name){
  const job=db.prepare(`SELECT json_extract(snapshot_json,'$.generationOrigin')='assistant' OR EXISTS(
   SELECT 1 FROM assistant_task_attempts WHERE external_kind='job' AND external_id=jobs.id
  ) AS from_assistant FROM jobs WHERE id=?`).get(jobId);
  name=job?.from_assistant?"画布助手":isComfy?"ComfyUI":"模型生成";
 }
 const prefix=`${name} · ${kindLabels[kind]} `;
 const usedTitles=new Set(nodes.map(node=>node.title));
 for(let number=1;;number++){
  const title=prefix+String(number).padStart(2,"0");
  if(!usedTitles.has(title))return title;
 }
}
