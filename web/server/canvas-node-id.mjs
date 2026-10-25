/** Opaque canvas identifiers use the node type as a prefix.
 * Plugin types include ':' (comfy:workflow), '.', '@' and '/'.
 * Do not reuse for project IDs, credential IDs or remote task IDs.
 */
export const CANVAS_NODE_ID_PATTERN="^[A-Za-z0-9_:@./-]{1,256}$";
const canvasIdPattern=new RegExp(CANVAS_NODE_ID_PATTERN);
export function validCanvasNodeId(id){
 return typeof id==="string"&&canvasIdPattern.test(id);
}
