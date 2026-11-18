const number = value => {
 const normalized=value.normalize("NFKC");
 if(/^\d+$/.test(normalized))return Number(normalized);
 const digits="零一二三四五六七八九";
 if(normalized==="十")return 10;
 if(normalized.length===1)return digits.indexOf(normalized);
 const [tens,ones]=normalized.split("十");
 return normalized.includes("十")?(tens?digits.indexOf(tens):1)*10+(ones?digits.indexOf(ones):0):-1;
};

const shotPattern=/(?:镜头|分镜)\s*[#＃第]?\s*([0-9０-９]{1,3}|[一二三四五六七八九十]{1,3})(?![0-9０-９])/g;

export function requestedHistoryShot(request){
 if(typeof request!=="string"||/(?:不要|不用|无需|别)(?:再)?\s*(?:引用|参考|使用|沿用)/.test(request))return null;
 if(!/(?:刚才|此前|之前|前面|上面|前文|上一轮|原先|原稿|原文|(?:分镜|镜头)(?:方案|稿)(?:里|中|的))/.test(request)||
  !/(?:转成|转为|转写|改写|改成|改编|转换|重写|写成|翻译|提取|沿用|引用|指的是|按照|根据|参照|参考|扩写|润色|细化|生成)/.test(request))return null;
 const shots=new Set([...request.matchAll(shotPattern)].map(match=>number(match[1])));
 if(shots.size!==1)return null;
 const [shot]=shots;
 return shot>0?shot:null;
}

export function findHistoryShotRanges(text,shot){
 const boundaries=[];
 let offset=0;
 let fence=null;
 for(const line of text.split(/(?<=\n)/)){
  const heading=line.trim();
  const fenceMarker=heading.match(/^(`{3,}|~{3,})/);
  if(fenceMarker){
   if(!fence)fence=fenceMarker[1];
   else if(fenceMarker[1][0]===fence[0]&&fenceMarker[1].length>=fence.length)fence=null;
  }else if(!fence){
   const marker=heading.match(/^(?:(#{1,6})\s+|(?:[-*+]\s+|\d+[.)、]\s*|\|\s*))?/);
   const title=heading.slice(marker[0].length).replace(/^(?:\*\*|__|【|\[)\s*/, "");
   const match=title.match(/^(?:镜头|分镜)\s*[#＃第]?\s*([0-9０-９]{1,3}|[一二三四五六七八九十]{1,3})(?=$|[\s|｜:：·.、，。—-]|\*\*|__|】|\]|（|\()/);
   if(match||marker[1])boundaries.push({start:offset,end:offset+line.length,
    level:marker[1]?.length??7,shot:match?number(match[1]):null,table:heading.startsWith("|"),
    label:title.replace(/[*_#|]+$/g,"").trim().slice(0,120)});
  }
  offset+=line.length;
 }
 return boundaries.flatMap((entry,index)=>{
  if(entry.shot!==shot)return [];
  const next=boundaries.slice(index+1).find(item=>item.shot!==null||item.level<=entry.level);
  const end=entry.start+text.slice(entry.start,entry.table?entry.end:next?.start??text.length).trimEnd().length;
  return [{start:entry.start,end,text:text.slice(entry.start,end),label:entry.label}];
 });
}
