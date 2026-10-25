import {useEffect} from "react";
import {useNavigate} from "react-router-dom";
import {App,Button} from "antd";
import {Plus} from "lucide-react";
import {useTranslation} from "react-i18next";
import {CanvasDeleteProjectsDialog} from "@/components/canvas/canvas-delete-projects-dialog";
import {CanvasProjectCard} from "@/components/canvas/canvas-project-card";
import {useCanvasStore} from "@/stores/canvas/use-canvas-store";
import {useCanvasUiStore} from "@/stores/canvas/use-canvas-ui-store";

/** Single library: SQLite. Legacy browser projects are never loaded. */
export default function CanvasPage(){
 const {message}=App.useApp(),{t}=useTranslation(),navigate=useNavigate();
 const hydrated=useCanvasStore(state=>state.hydrated);
 const backendError=useCanvasStore(state=>state.error);
 const loadProjects=useCanvasStore(state=>state.loadProjects);
 const projects=useCanvasStore(state=>state.projects);
 const createProject=useCanvasStore(state=>state.createProject);
 const selectedIds=useCanvasUiStore(state=>state.selectedProjectIds);
 const setDeleteIds=useCanvasUiStore(state=>state.setDeleteProjectIds);
 useEffect(()=>{void loadProjects().catch(()=>{})},[loadProjects]);
 const createAndEnter=async()=>{
  try{
   const id=await createProject(t("canvas.defaultTitle",{count:projects.length+1}));
   navigate("/canvas/"+id);
  }catch(error){message.error("SQLite 项目创建失败："+String(error))}
 };
 return <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
  <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
   <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
    <div><p className="text-xs text-stone-500">{t("canvas.library")}</p>
     <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1></div>
    <div className="flex items-center gap-2">
     {selectedIds.length?<Button disabled={!hydrated||!!backendError}
      onClick={()=>setDeleteIds(selectedIds)}>{t("canvas.deleteSelected")}</Button>:null}
     {projects.length?<Button disabled={!hydrated||!!backendError}
      onClick={()=>setDeleteIds(projects.map(item=>item.id))}>{t("canvas.deleteAll")}</Button>:null}
     <Button disabled={!hydrated||!!backendError} type="primary" icon={<Plus className="size-4"/>}
      onClick={()=>void createAndEnter()}>{t("canvas.create")}</Button>
    </div>
   </header>
   {backendError?<section role="alert" className="rounded-xl border border-red-500/50 p-5">
    SQLite 后端不可用或保存失败：{backendError}
    <Button className="ml-3" onClick={()=>void loadProjects().catch(()=>{})}>重试连接</Button>
   </section>:null}
   {!hydrated?<section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>:
    projects.length?<div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
     {projects.map(project=><CanvasProjectCard key={project.id} project={project}/>)}
    </div>:<section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
     <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
     <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
     <Button type="primary" className="mt-6" icon={<Plus className="size-4"/>}
      disabled={!!backendError} onClick={()=>void createAndEnter()}>{t("canvas.create")}</Button>
    </section>}
  </div>
  <CanvasDeleteProjectsDialog/>
 </main>
}
