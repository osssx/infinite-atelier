import {Check,X} from "lucide-react";
import type {CanvasTheme} from "@/lib/canvas-theme";

/** Shared compact, theme-aware actions for staged drama draft field edits. */
export function DramaEditActions({theme,label,disabled,onCancel,onConfirm}:{
 theme:CanvasTheme;label:string;disabled:boolean;onCancel:()=>void;onConfirm:()=>void;
}){
 const common="inline-flex min-h-7 min-w-[68px] items-center justify-center gap-1 rounded-md border px-2.5 text-[11px] font-semibold leading-none transition-[background-color,opacity] hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45";
 return <div data-episode-edit-actions="" data-drama-edit-actions="" aria-label={label+"操作"}
  className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 pt-1">
  <button type="button" data-episode-action="cancel" data-drama-action="cancel" className={common}
   style={{background:theme.node.panel,borderColor:theme.node.stroke,color:theme.node.muted,
    outlineColor:theme.node.activeStroke}} onClick={onCancel}>
   <X size={12} aria-hidden="true"/>取消
  </button>
  <button type="button" data-episode-action="confirm" data-drama-action="confirm" aria-label={"确认"+label} className={common}
   style={{background:theme.node.text,borderColor:theme.node.text,color:theme.node.panel,
    outlineColor:theme.node.activeStroke}} disabled={disabled} onClick={onConfirm}>
   <Check size={12} aria-hidden="true"/>确认
  </button>
 </div>;
}
