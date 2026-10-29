import type {ComfyTemplatePort} from "./template-schema";

/** Reorder ports on one physical side of a workflow node.
 * Input/output bindings, IDs and the other side's relative order are untouched.
 * Preserve interleaved slots in the persisted array for existing templates.
 */
export function reorderComfyCanvasPorts(
    ports:readonly ComfyTemplatePort[],
    movingId:string,
    targetId:string,
    placement:"before"|"after"="before",
):ComfyTemplatePort[] {
    const moving=ports.find(port=>port.id===movingId);
    const target=ports.find(port=>port.id===targetId);
    if(!moving||!target||movingId===targetId||moving.direction!==target.direction)
        return ports as ComfyTemplatePort[];
    const originalSide=ports.filter(port=>port.direction===moving.direction);
    const side=[...originalSide];
    const from=side.findIndex(port=>port.id===movingId);
    side.splice(from,1);
    const targetIndex=side.findIndex(port=>port.id===targetId);
    side.splice(targetIndex+(placement==="after"?1:0),0,moving);
    const unchanged=side.every((port,index)=>port.id===originalSide[index].id);
    if(unchanged)return ports as ComfyTemplatePort[];
    let index=0;
    return ports.map(port=>port.direction===moving.direction?side[index++]:port);
}

/** Accessible single-step alternative to drag-and-drop. */
export function moveComfyCanvasPort(
    ports:readonly ComfyTemplatePort[],portId:string,step:-1|1,
):ComfyTemplatePort[] {
    const current=ports.find(port=>port.id===portId);
    if(!current)return ports as ComfyTemplatePort[];
    const side=ports.filter(port=>port.direction===current.direction);
    const index=side.findIndex(port=>port.id===portId);
    const neighbor=side[index+step];
    return neighbor?reorderComfyCanvasPorts(ports,portId,neighbor.id,step<0?"before":"after")
        :ports as ComfyTemplatePort[];
}
