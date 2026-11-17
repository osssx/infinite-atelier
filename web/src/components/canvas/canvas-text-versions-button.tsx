import {History} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";

export function CanvasTextVersionsButton({nodeId,label,theme,onOpen}:{nodeId:string;label:string;theme:CanvasTheme;onOpen:(nodeId:string)=>void}){
 const stop=(event:{stopPropagation:()=>void})=>event.stopPropagation();
 return <button type="button" data-canvas-shortcuts-ignore className="inline-flex size-8 items-center justify-center rounded-full border opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100"
  style={{background:`${theme.toolbar.panel}dd`,borderColor:theme.node.stroke,color:theme.node.text}}
  onClick={event=>{event.stopPropagation();onOpen(nodeId);}} onPointerDown={stop} onMouseDown={stop} onDoubleClick={stop}
  title={label} aria-label={label}><History className="size-4" aria-hidden="true"/></button>;
}
