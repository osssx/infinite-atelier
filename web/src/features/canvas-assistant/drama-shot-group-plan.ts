import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import type {DramaShot} from "./canvas-drama-pipeline";

/** Convert an explicit confirmed-shot selection to the ordered set of video
 * Config node IDs. This is a *preparation only* step: no generated media,
 * dependency, tail-frame take or Job can be created here.
 */
export function resolveDramaShotGroupConfigs(
    confirmedShots:readonly DramaShot[],
    selectedShotIds:readonly string[],
    configs:ReadonlyMap<string,CanvasNodeData>,
):string[]{
    if(selectedShotIds.length<2||selectedShotIds.length>128)
        throw Error("请从已确认分镜中选择 2–128 个镜头组建批量任务");
    if(new Set(selectedShotIds).size!==selectedShotIds.length)
        throw Error("同一个镜头不能在批量任务中重复出现");
    const byId=new Map(confirmedShots.map(shot=>[shot.id,shot]));
    const selected=selectedShotIds.map(id=>{
        const shot=byId.get(id),config=configs.get(id);
        if(!shot)throw Error("镜头已从确认分镜中移除："+id);
        if(!config||config.type!==CanvasNodeType.Config||
            config.metadata?.generationMode!=="video"||config.metadata.dramaShotId!==shot.id)
            throw Error("镜头缺少有效的视频 Config："+id);
        if(config.metadata?.groupId)
            throw Error("视频 Config 已属于其他镜头组，请先解除原分组："+id);
        return {shot,config};
    });
    const configIds=selected.map(item=>item.config.id);
    if(new Set(configIds).size!==configIds.length)
        throw Error("多个分镜镜头引用了同一个视频 Config，请先修正连接");
    return selected.sort((a,b)=>a.shot.episodeId.localeCompare(b.shot.episodeId)||
        a.shot.order-b.shot.order||a.shot.id.localeCompare(b.shot.id)).map(item=>item.config.id);
}
