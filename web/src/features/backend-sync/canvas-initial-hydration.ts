/** Canvas load may replace in-memory node/edge objects (image hydration,
 * restored previews, default instance selection) without changing the
 * persisted graph. Only genuine generation-state reset or connection repair
 * should advance the backend project revision on initial load.
 *
 * Called ONCE per project load, never on the 60fps interaction hot path.
 */
export function initialHydrationNeedsGraphSave<Node,Connection>({
 persistedNodes,persistedConnections,resetNodes,reconciledConnections
}:{
 persistedNodes:readonly Node[];
 persistedConnections:readonly Connection[];
 resetNodes:readonly Node[];
 reconciledConnections:readonly Connection[];
}):boolean{
 return JSON.stringify(persistedNodes)!==JSON.stringify(resetNodes)||
  JSON.stringify(persistedConnections)!==JSON.stringify(reconciledConnections);
}
