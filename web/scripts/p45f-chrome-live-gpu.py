"""P4.5f real Chrome click -> one explicit Grant -> local GPU Moss -> trusted
first_frame binding -> Chrome authorized MiniMax H3 I2V -> CAS video playback.

New GPU work is NEVER implicit. This script needs --live-gpu, uses a fresh
disposable SQLite/CAS root and the existing exact-once P4.5d acceptance script.
Run: python scripts/p45f-chrome-live-gpu.py --live-gpu
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

h=runpy.run_path(str(Path(__file__).with_name("p45f-chrome-browser-e2e.py")))
ChromeCDP=h["ChromeCDP"]
bound_port=h["bound_port"]
wait_for=h["wait_for"]
kill_tree=h["kill_tree"]
CHROME=h["CHROME"]
ROOT=h["ROOT"]
task_content_contains=h["task_content_contains"]

def stats(root:Path,task_id:str):
    con=sqlite3.connect("file:"+str(root/"db"/"atelier.sqlite").replace("\\","/")+"?mode=ro",uri=True)
    try:
        jobs=con.execute("SELECT id,status,target_node_id FROM jobs ORDER BY created_at").fetchall()
        events=con.execute("SELECT kind FROM assistant_task_events WHERE task_id=? AND kind IN ('run_budget_granted','run_budget_consumed')",(task_id,)).fetchall()
        task=con.execute("SELECT status FROM assistant_tasks WHERE id=?",(task_id,)).fetchone()
        document=json.loads(con.execute("SELECT document_json FROM projects LIMIT 1").fetchone()[0])
        materials=con.execute("SELECT status FROM materializations ORDER BY id").fetchall()
        return dict(jobs=jobs,granted=sum(kind=="run_budget_granted" for (kind,) in events),
                    consumed=sum(kind=="run_budget_consumed" for (kind,) in events),
                    task=task[0] if task else None,materials=materials,
                    nodes=[(n["id"],n["type"],n.get("metadata",{}).get("storageKey")) for n in document["nodes"]],
                    edges=document["connections"])
    finally: con.close()

def stage(marker:Path,name:str,limit:float):
    end=time.monotonic()+limit
    last=None
    while time.monotonic()<end:
        try:
            item=json.loads(marker.read_text("utf8"))
            last=item.get("stage")
            if last=="failed":raise AssertionError("gpu_acceptance_failed:"+str(item.get("error")))
            if last==name:return item
            if last=="completed_waiting_browser" and name!="completed_waiting_browser":
                raise AssertionError("stage_skipped:"+name)
        except (OSError,UnicodeError,json.JSONDecodeError):pass
        time.sleep(.4)
    raise AssertionError("gpu_browser_stage_timeout:"+name+" last="+str(last))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--live-gpu",action="store_true",help="explicit new local GPU jobs opt-in")
    args=ap.parse_args()
    if not args.live_gpu:raise SystemExit("P45F_REAL_GPU_EXPLICIT_OPT_IN_REQUIRED: --live-gpu")
    if not CHROME.exists():raise AssertionError("Chrome missing")
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-p45f-live-"))
    marker=root/"browser-gate.json"
    backend_port,vite_port,chrome_port=bound_port(),bound_port(),bound_port()
    assert len({backend_port,vite_port,chrome_port})==3
    env=dict(os.environ,ATELIER_MINIMAX_LIVE="1",
             ATELIER_MINIMAX_MEDIA_CONSENT="1",ATELIER_P45F_REAL_BROWSER_GATE="1",
             ATELIER_P45F_GATE_MARKER=str(marker),ATELIER_BACKEND_PORT=str(backend_port))
    server=vite=chrome=None;page=None
    logs=[];reported=None
    result=dict(phase="starting",harnessRoot=str(root),assertions=[])
    def launch(label,argv,e=env):
        f=open(root/(label+".log"),"w",encoding="utf8",errors="replace")
        logs.append(f)
        return subprocess.Popen(argv,cwd=ROOT,env=e,stdin=subprocess.DEVNULL,
                                stdout=f,stderr=subprocess.STDOUT)
    def check(label,condition):
        if not condition:raise AssertionError("p45f_live_browser_check:"+label)
        result["assertions"].append(label)
        print("P45F_REAL_GPU_BROWSER_ASSERT "+label,flush=True)
    try:
        # P4.5d script preflight checks actual published local templates, Comfy
        # object_info, queue emptiness, and creates an isolated test dataset.
        server=launch("acceptance",["node","scripts/minimax-p3c2-live-acceptance.mjs"])
        intro=stage(marker,"consent_waiting",90)
        data=Path(intro["root"])
        result["dataRoot"]=str(data)
        check("clean_isolated_project_before_chrome_grant",
              stats(data,intro["taskId"])["jobs"]==[])
        front=f"http://127.0.0.1:{vite_port}"
        vite=launch("vite",["node","node_modules/vite/bin/vite.js",
                            "--host","127.0.0.1","--port",str(vite_port),"--strictPort"],
                   dict(env,ATELIER_BACKEND_URL=intro["backendOrigin"]))
        wait_for(lambda:urllib.request.urlopen(front,timeout=2).status==200,"vite ready",45)
        chrome=launch("chrome",[str(CHROME),"--headless=new","--disable-gpu",
                      "--autoplay-policy=no-user-gesture-required",
                      "--no-first-run","--no-default-browser-check",
                      f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",
                      f"--user-data-dir={root/'chrome-profile'}",
                      "--window-size=1600,1000","about:blank"])
        wait_for(lambda:h["get_json"](f"http://127.0.0.1:{chrome_port}/json/version"),
                 "Chrome CDP",40)
        page=ChromeCDP(chrome_port)
        page.call("Page.navigate",{"url":front+"/canvas/"+intro["projectId"]})
        wait_for(lambda:page.js("document.readyState")=="complete","canvas document",40)
        wait_for(lambda:page.js("document.querySelectorAll('button').length")>12,
                 "real canvas",45)
        page.js("""window.dispatchEvent(new KeyboardEvent('keydown',
            {key:'i',altKey:true,bubbles:true,cancelable:true}));true""")
        wait_for(lambda:bool(page.js("""!!document.querySelector('section[aria-label="任务状态"]')""")),
                 "real assistant",40)
        # The Task detail may collapse while React hydrates its frozen Step.
        if page.click("任务详情"):time.sleep(.4)
        wait_for(lambda:bool(page.js("""!!document.querySelector(
                    'input[aria-label="确认本地媒体链自动绑定与生成"]')""")),
                 "live consent widget",40)
        checkbox='input[aria-label="确认本地媒体链自动绑定与生成"]'
        check("browser_user_checks_explicit_local_gpu_consent",
              bool(page.js("""(()=>{const el=document.querySelector(%s);
                 if(!el)return false;el.click();return el.checked})()""" % json.dumps(checkbox))))
        wait_for(lambda:bool(page.js("""[...document.querySelectorAll('button')].some(
          b=>(b.innerText||'').trim()==='批准唯一媒体连线及一次 ComfyUI 生成'&&
          !b.disabled&&b.getClientRects().length>0)""")),
          "grant button visible and enabled",25)
        check("browser_user_clicks_once_media_grant",
              page.click("批准唯一媒体连线及一次 ComfyUI 生成"))
        wait_for(lambda:stats(data,intro["taskId"])["granted"]==1,"grant stored",35)
        check("browser_grant_persisted_exactly_once",
              stats(data,intro["taskId"])["granted"]==1)
        page.screenshot(root/"browser-consent.png")
        print("P45F_GPU_IMAGE_IN_PROGRESS waiting for real ComfyUI CAS",flush=True)
        mid=stage(marker,"video_waiting",900)
        before=stats(data,intro["taskId"])
        check("real_moss_image_materialized_once",len(before["jobs"])==1 and
              before["jobs"][0][1]=="succeeded" and
              len(before["materials"])==1 and before["materials"][0][0]=="materialized")
        check("server_committed_single_first_frame_edge",sum(
              e["fromNodeId"]=="moss-image-source" and
              e["toNodeId"]=="minimax-i2v-workflow" and e["toPortId"]=="first_frame"
              for e in before["edges"])==1)
        check("no_video_job_before_browser_click",before["consumed"]==0)
        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","image route refresh",40)
        wait_for(lambda:page.js("document.querySelectorAll('button').length")>12,
                 "canvas after image",40)
        page.js("""window.dispatchEvent(new KeyboardEvent('keydown',
            {key:'i',altKey:true,bubbles:true,cancelable:true}));true""")
        wait_for(lambda:bool(page.js("!!document.querySelector('section[aria-label=\"任务状态\"]')")),
                 "assistant after image",35)
        wait_for(lambda:task_content_contains(page,
                    "使用原授权恢复一次本地 ComfyUI 生成"),"frozen video approval",45)
        check("browser_restored_frozen_video_step",True)
        check("browser_clicks_single_authorized_video_enqueue",
              page.click("使用原授权恢复一次本地 ComfyUI 生成"))
        wait_for(lambda:len(stats(data,intro["taskId"])["jobs"])==2,
                 "real MiniMax job created",50)
        check("exactly_one_video_job_and_one_consumed_grant",
              len(stats(data,intro["taskId"])["jobs"])==2 and
              stats(data,intro["taskId"])["consumed"]==1)
        print("P45F_GPU_VIDEO_IN_PROGRESS waiting for MiniMax H3 output",flush=True)
        end=stage(marker,"completed_waiting_browser",1800)
        after=stats(data,intro["taskId"])
        check("real_jobs_both_succeeded_and_task_completed",
              len(after["jobs"])==2 and all(row[1]=="succeeded" for row in after["jobs"])
              and after["task"]=="completed")
        check("two_trusted_materializations_final",
              len(after["materials"])==2 and
              all(row[0]=="materialized" for row in after["materials"]))
        check("real_video_artifact_connected_to_workflow",any(
              n[1]=="video" for n in after["nodes"]) and
              any(e["fromNodeId"]=="minimax-i2v-workflow" and
                  e["toPortId"]=="comfy-artifact" for e in after["edges"]))
        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","video document reload",40)
        wait_for(lambda:page.js("document.querySelector('[data-canvas-video-cover]')!==null"),
                 "final video cover",50)
        check("browser_clicks_newly_generated_real_video",
              bool(page.js("""(()=>{const b=document.querySelector('[data-canvas-video-cover]');
                if(!b)return false;b.click();return true})()""")))
        decoded=wait_for(lambda:page.js("""(()=>{const v=document.querySelector('video[data-canvas-video-player]');
          return v&&v.videoWidth>0?{w:v.videoWidth,h:v.videoHeight,
          src:v.currentSrc||v.src}:null})()"""),"new video decoded",50)
        check("real_mini_h3_video_decodes_in_chrome",
              decoded["w"]>0 and decoded["h"]>0 and
              end["videoSha256"] in decoded["src"])
        browser_media=page.js("""(async()=>{const sha=%s;
          const r=await fetch('/api/v1/blobs/'+sha);
          const bytes=new Uint8Array(await r.arrayBuffer());
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))
            .map(x=>x.toString(16).padStart(2,'0')).join('');
          return {status:r.status,size:bytes.byteLength,hash,
                  signature:String.fromCharCode(...bytes.slice(4,8))};
        })()""" % json.dumps(end["videoSha256"]))
        check("new_video_browser_cas_sha256_matches",
              browser_media["status"]==200 and browser_media["hash"]==end["videoSha256"]
              and browser_media["size"]==end["videoBytes"] and
              browser_media["signature"]=="ftyp")
        result["media"]=dict(decoded=decoded,browser=browser_media)
        page.screenshot(root/"browser-real-video.png")
        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","final refresh",40)
        check("no_repeat_job_on_browser_refresh",stats(data,intro["taskId"])==after)
        result.update(phase="pass",dataRoot=str(data),
                      summary=dict(jobs=2,newRealGPUJobs=2,consumedGrants=1,
                                   mediaSha256=end["videoSha256"],assertions=len(result["assertions"])))
        marker.with_name(marker.name+".ack").write_text("chrome_verified\n","utf8")
        # The GPU service owns the final report and cleans up its own Runtime.
        wait_for(lambda:server.poll() is not None,"real GPU acceptance exit",40)
        check("p45d_real_gpu_acceptance_exited_successfully",server.returncode==0)
        result["summary"]["assertions"]=len(result["assertions"])
        print("P45F_CHROME_REAL_GPU_MEDIA_CHAIN_PASS "+json.dumps(result["summary"]),flush=True)
    except BaseException as exc:
        result.update(phase="failed",error=str(exc)[:1300])
        if page:
            try:
                result["visibleUI"]=page.text()[:5500]
                page.screenshot(root/"failure.png")
            except Exception as e:result["captureError"]=str(e)
        print("P45F_CHROME_REAL_GPU_MEDIA_CHAIN_FAIL "+repr(exc),flush=True)
        raise
    finally:
        if page:
            result["browserRequests"]=page.network_requests[-100:]
            result["browserExceptions"]=page.exceptions[-20:]
            try:page.close()
            except Exception:pass
        for proc in (chrome,vite,server):kill_tree(proc)
        for f in logs:f.close()
        (root/"p45f-chrome-live-gpu-report.json").write_text(
            json.dumps(result,indent=2,ensure_ascii=False),"utf8")
        print("P45F_CHROME_LIVE_REPORT_PATH="+str(root/"p45f-chrome-live-gpu-report.json"),flush=True)

if __name__=="__main__":main()
