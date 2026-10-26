import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import {CanvasNodeType} from "@/types/canvas";

/** SQLite retries submit a new append-only job from a producer, never from
 * an already-successful artifact. Prefer a Config ancestor; otherwise use
 * the sole directly connected Text producer. Ambiguous graphs fail closed. */
export function findSqliteModelRetrySource(
 output:CanvasNodeData,nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[]
):CanvasNodeData{
 const byId=new Map(nodes.map(node=>[node.id,node]));
 const parents=new Map<string,string[]>();
 for(const edge of connections){
  const items=parents.get(edge.toNodeId)??[];
  items.push(edge.fromNodeId);parents.set(edge.toNodeId,items);
 }
 const queue=[...(parents.get(output.id)??[])],visited=new Set<string>();
 while(queue.length){
  const id=queue.shift()!;
  if(visited.has(id))continue;
  visited.add(id);
  const node=byId.get(id);
  if(node?.type===CanvasNodeType.Config)return node;
  for(const parent of parents.get(id)??[])queue.push(parent);
 }
 const direct=[...new Set(parents.get(output.id)??[])]
  .map(id=>byId.get(id)).filter((n):n is CanvasNodeData=>
   !!n&&(n.type===CanvasNodeType.Config||n.type===CanvasNodeType.Text));
 return direct.length===1?direct[0]:output;
}
