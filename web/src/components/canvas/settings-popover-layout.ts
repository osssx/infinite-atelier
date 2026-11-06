export type SettingsPopoverPlacement="topLeft"|"top"|"topRight"|"bottomLeft"|"bottom"|"bottomRight";

export function calculateSettingsPopoverHorizontalPosition(
    anchor:Pick<DOMRect,"left"|"right"|"width">,
    placement:SettingsPopoverPlacement|undefined,
    requestedWidth:number,
    viewportWidth:number,
):{width:number;left:number}{
    const width=Math.min(requestedWidth,Math.max(0,viewportWidth-24));
    const alignRight=placement?.endsWith("Right");
    const alignCenter=placement==="top"||placement==="bottom";
    const desired=alignCenter?anchor.left+anchor.width/2-width/2:alignRight?anchor.right-width:anchor.left;
    const edge=Math.min(12,Math.max(0,(viewportWidth-width)/2));
    return {width,left:Math.max(edge,Math.min(viewportWidth-width-edge,desired))};
}
