import type {CanvasTheme} from "@/lib/canvas-theme";
import type {DramaAssetUsageEntry} from "./drama-asset-usage-display";

export function DramaAssetUsageTags({entries,theme}:{entries:readonly DramaAssetUsageEntry[];theme:CanvasTheme}){
 if(!entries.length)return null;
 return <section aria-label="使用位置" className="min-w-0 space-y-1.5" data-asset-usage-tags="">
  <div className="flex items-center gap-2 text-xs font-medium" style={{color:theme.node.muted}}>使用位置 <span className="tabular-nums">{entries.length} 个镜头</span></div>
  <div className="thin-scrollbar flex max-h-32 min-w-0 flex-wrap content-start items-start gap-1.5 overflow-y-auto overscroll-contain py-0.5">
   {entries.map(entry=><span key={entry.key} className="inline-flex max-w-full shrink-0 items-center rounded-md border px-2 py-0.5 text-xs leading-relaxed"
    style={{background:theme.toolbar.activeBg,borderColor:theme.node.stroke,color:theme.node.text}}>{entry.label}</span>)}
  </div>
 </section>;
}
