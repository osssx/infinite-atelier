import {CanvasNodeType,type CanvasConnection,type CanvasNodeData,type Position} from "@/types/canvas";

/** Structure-aware layout: groups are atomic visual units, but their members move with them. */
export type AssistantGraphLayoutDirection="horizontal"|"vertical";
export type AssistantGraphLayoutOptions={
 nodeIds:readonly string[];direction:AssistantGraphLayoutDirection;
 gap:number;layerGap:number;center:Position;
};
const MAX_COORD=1_000_000,MAX_UNITS=200;
type Bounds={left:number;top:number;right:number;bottom:number;width:number;height:number};
type Unit={id:string;node:CanvasNodeData;members:CanvasNodeData[];bounds:Bounds};
const finite=(n:number)=>Number.isFinite(n)&&Math.abs(n)<=MAX_COORD;
const boundsOf=(nodes:readonly CanvasNodeData[]):Bounds=>{
 const left=Math.min(...nodes.map(n=>n.position.x));
 const top=Math.min(...nodes.map(n=>n.position.y));
 const right=Math.max(...nodes.map(n=>n.position.x+n.width));
 const bottom=Math.max(...nodes.map(n=>n.position.y+n.height));
 const width=right-left,height=bottom-top;
 if(![left,top,right,bottom].every(finite)||!Number.isFinite(width)||!Number.isFinite(height)||
  width<=0||height<=0||width>MAX_COORD||height>MAX_COORD)
  throw Error("节点或分组尺寸超出安全范围，未执行。");
 return {left,top,right,bottom,width,height};
};
const unitKey=(node:CanvasNodeData)=>node.metadata?.groupId??node.id;
function centerForSort(unit:Unit,direction:AssistantGraphLayoutDirection):number{
 return direction==="horizontal"?(unit.bounds.top+unit.bounds.bottom)/2:(unit.bounds.left+unit.bounds.right)/2;
}
function positionGrid(units:readonly Unit[],center:Position,gap:number):Map<string,Position>{
 const columns=Math.max(1,Math.ceil(Math.sqrt(units.length)));
 const rows=Math.ceil(units.length/columns);
 const widths=Array.from({length:columns},(_,col)=>Math.max(...units.filter((_,i)=>i%columns===col).map(u=>u.bounds.width)));
 const heights=Array.from({length:rows},(_,row)=>Math.max(...units.slice(row*columns,(row+1)*columns).map(u=>u.bounds.height)));
 const totalWidth=widths.reduce((a,b)=>a+b,0)+gap*(columns-1);
 const totalHeight=heights.reduce((a,b)=>a+b,0)+gap*(rows-1);
 const result=new Map<string,Position>();
 let y=center.y-totalHeight/2;
 for(let row=0;row<rows;row++){
  let x=center.x-totalWidth/2;
  for(let col=0;col<columns;col++){
   const unit=units[row*columns+col];
   if(unit)result.set(unit.id,{x:x+(widths[col]-unit.bounds.width)/2,
    y:y+(heights[row]-unit.bounds.height)/2});
   x+=widths[col]+gap;
  }
  y+=heights[row]+gap;
 }
 return result;
}
/** Pure, deterministic and bounded. Coordinates are absolute; no edge or metadata writes. */
export function layoutCanvasDependencyGraph(
 nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[],options:AssistantGraphLayoutOptions
):CanvasNodeData[]{
 const {nodeIds,direction,gap,layerGap,center}=options;
 if((direction!=="horizontal"&&direction!=="vertical")||
  !Number.isInteger(gap)||gap<16||gap>160||
  !Number.isInteger(layerGap)||layerGap<40||layerGap>360||
  !finite(center.x)||!finite(center.y)||!Array.isArray(nodeIds)||nodeIds.length>MAX_UNITS)
  throw Error("自动布局参数无效，未执行。");
 const byId=new Map(nodes.map(n=>[n.id,n]));
 if(byId.size!==nodes.length)throw Error("画布节点 ID 重复，无法布局。");
 for(const node of nodes){
  const parent=node.metadata?.groupId;
  if(!parent)continue;
  if(node.type===CanvasNodeType.Group||parent===node.id||
   byId.get(parent)?.type!==CanvasNodeType.Group||byId.get(parent)?.metadata?.groupId)
   throw Error("画布分组关系无效，无法自动布局。");
 }
 const selectedIds=nodeIds.length?nodeIds:
  nodes.filter(n=>!n.metadata?.groupId).map(n=>n.id);
 if(new Set(selectedIds).size!==selectedIds.length)
  throw Error("自动布局节点重复，未执行。");
 if(selectedIds.length===0||selectedIds.length>MAX_UNITS)
  throw Error("请选择 1 至 200 个节点进行自动布局。");
 const units=selectedIds.map(id=>{
  const node=byId.get(id);
  if(!node)throw Error("自动布局节点不存在，未执行。");
  if(node.metadata?.groupId)throw Error("请选中整个分组，不能单独布局分组成员。");
  const members=node.type===CanvasNodeType.Group?
   nodes.filter(member=>member.metadata?.groupId===id):[];
  return {id,node,members,bounds:boundsOf([node,...members])};
 });
 const unitById=new Map(units.map(u=>[u.id,u]));
 const selected=new Set(selectedIds);
 const edges=new Map<string,Set<string>>(units.map(u=>[u.id,new Set<string>()]));
 const incoming=new Map<string,Set<string>>(units.map(u=>[u.id,new Set<string>()]));
 for(const connection of connections){
  const from=byId.get(connection.fromNodeId),to=byId.get(connection.toNodeId);
  if(!from||!to)continue; // Legacy dangling edges cannot be repaired by layout.
  const a=unitKey(from),b=unitKey(to);
  if(a===b||!selected.has(a)||!selected.has(b))continue; // Intra-group links do not create DAG cycles.
  edges.get(a)!.add(b);incoming.get(b)!.add(a);
 }
 const originOrder=new Map(units.slice().sort((a,b)=>
  centerForSort(a,direction)-centerForSort(b,direction)||
  a.bounds.left-b.bounds.left||a.bounds.top-b.bounds.top||a.id.localeCompare(b.id)
 ).map((u,i)=>[u.id,i]));
 const compareOriginal=(a:string,b:string)=>(originOrder.get(a)??0)-(originOrder.get(b)??0);
 const degrees=new Map(units.map(u=>[u.id,incoming.get(u.id)!.size]));
 const queue=units.map(u=>u.id).filter(id=>degrees.get(id)===0).sort(compareOriginal);
 const ranks=new Map<string,number>(units.map(u=>[u.id,0]));
 let processed=0;
 while(queue.length){
  const id=queue.shift()!;processed++;
  for(const next of [...edges.get(id)!].sort(compareOriginal)){
   ranks.set(next,Math.max(ranks.get(next)!,ranks.get(id)!+1));
   degrees.set(next,degrees.get(next)!-1);
   if(degrees.get(next)===0){queue.push(next);queue.sort(compareOriginal);}
  }
 }
 if(processed!==units.length)throw Error("节点连线存在循环依赖，已取消自动布局。");
 const edgeCount=[...edges.values()].reduce((n,set)=>n+set.size,0);
 const ordered=units.slice().sort((a,b)=>compareOriginal(a.id,b.id));
 let positions:Map<string,Position>;
 if(edgeCount===0){
  positions=positionGrid(ordered,center,gap);
 }else{
  const maxRank=Math.max(...ranks.values());
  const layers=Array.from({length:maxRank+1},()=>[] as string[]);
  for(const u of ordered)layers[ranks.get(u.id)!].push(u.id);
  // Alternating median/barycenter sweeps reduce crossing without rewiring anything.
  for(let sweep=0;sweep<5;sweep++){
   const forward=sweep%2===0;
   const indices=forward?layers.map((_,i)=>i).slice(1):
    layers.map((_,i)=>i).slice(0,-1).reverse();
   for(const rank of indices){
    const neighbors=forward?incoming:edges;
    const sibling=forward?layers[rank-1]:layers[rank+1];
    const siblingOrder=new Map(sibling.map((id,i)=>[id,i]));
    const orderWithinRanks=new Map(layers.flat().map((id,i)=>[id,i]));
    const bary=(id:string)=>{
     const adjacent=[...neighbors.get(id)!];
     if(!adjacent.length)return {value:orderWithinRanks.get(id)??0,has:false};
     const scores=adjacent.map(n=>siblingOrder.get(n)??orderWithinRanks.get(n)??0);
     return {value:scores.reduce((a,b)=>a+b,0)/scores.length,has:true};
    };
    layers[rank].sort((a,b)=>{
     const x=bary(a),y=bary(b);
     return x.has&&y.has?(x.value-y.value||compareOriginal(a,b)):compareOriginal(a,b);
    });
   }
  }
  const widths=layers.map(layer=>Math.max(...layer.map(id=>unitById.get(id)!.bounds.width)));
  const heights=layers.map(layer=>Math.max(...layer.map(id=>unitById.get(id)!.bounds.height)));
  const stacks=layers.map(layer=>direction==="horizontal"?
   layer.reduce((sum,id)=>sum+unitById.get(id)!.bounds.height,0)+gap*(layer.length-1):
   layer.reduce((sum,id)=>sum+unitById.get(id)!.bounds.width,0)+gap*(layer.length-1));
  positions=new Map();
  if(direction==="horizontal"){
   const totalWidth=widths.reduce((a,b)=>a+b,0)+layerGap*maxRank;
   let x=center.x-totalWidth/2;
   for(let rank=0;rank<layers.length;rank++){
    let y=center.y-stacks[rank]/2;
    for(const id of layers[rank]){
     const box=unitById.get(id)!.bounds;
     positions.set(id,{x:x+(widths[rank]-box.width)/2,y});
     y+=box.height+gap;
    }
    x+=widths[rank]+layerGap;
   }
  }else{
   const totalHeight=heights.reduce((a,b)=>a+b,0)+layerGap*maxRank;
   let y=center.y-totalHeight/2;
   for(let rank=0;rank<layers.length;rank++){
    let x=center.x-stacks[rank]/2;
    for(const id of layers[rank]){
     const box=unitById.get(id)!.bounds;
     positions.set(id,{x,y:y+(heights[rank]-box.height)/2});
     x+=box.width+gap;
    }
    y+=heights[rank]+layerGap;
   }
  }
 }
 const movements=new Map<string,Position>();
 for(const unit of units){
  const pos=positions.get(unit.id)!;
  movements.set(unit.id,{x:pos.x-unit.bounds.left,y:pos.y-unit.bounds.top});
 }
 return nodes.map(node=>{
  const delta=movements.get(unitKey(node));
  if(!delta)return node;
  const position={x:node.position.x+delta.x,y:node.position.y+delta.y};
  if(!finite(position.x)||!finite(position.y)||
   !finite(position.x+node.width)||!finite(position.y+node.height))
   throw Error("布局结果超出画布坐标范围，未执行。");
  return {...node,position};
 });
}
