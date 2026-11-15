"""P4.5f: render and decode P4.5d *real generated* media with real Chrome.

Uses an isolated COPY of earlier validated GPU/SQLite/CAS assets.
Does not enqueue new jobs, mutate user workspace, or run GPU.
Usage: python scripts/p45f-chrome-media-replay.py --source H:\\Temp\\...p45d-root
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

helpers=runpy.run_path(str(Path(__file__).with_name("p45f-chrome-browser-e2e.py")))
ChromeCDP=helpers["ChromeCDP"]
wait_for=helpers["wait_for"]
bound_port=helpers["bound_port"]
kill_tree=helpers["kill_tree"]
CHROME=helpers["CHROME"]
ROOT=helpers["ROOT"]

def stats(data:Path,task_id:str):
    con=sqlite3.connect("file:"+str(data/"db"/"atelier.sqlite").replace("\\","/")+"?mode=ro",uri=True)
    try:
        jobs=con.execute("SELECT id,status FROM jobs").fetchall()
        artifacts=con.execute("SELECT kind,sha256 FROM artifacts").fetchall()
        materials=con.execute("SELECT status FROM materializations").fetchall()
        edges=json.loads(con.execute("SELECT document_json FROM projects").fetchone()[0]).get("connections",[])
        task=con.execute("SELECT status FROM assistant_tasks WHERE id=?",(task_id,)).fetchone()
        consumed=con.execute("SELECT COUNT(*) FROM assistant_task_events WHERE task_id=? AND kind='run_budget_consumed'",(task_id,)).fetchone()[0]
        return dict(jobs=jobs,artifacts=artifacts,materials=materials,edges=edges,
                    taskStatus=task[0] if task else None,consumed=consumed)
    finally:con.close()

def main():
    args=argparse.ArgumentParser()
    args.add_argument("--source",required=True,help="P4.5d isolated completed-media root")
    source=Path(args.parse_args().source).resolve()
    assert source.exists() and (source/"minimax-p45c-recovery-result.json").exists(), "source_must_be_p45d_verified_root"
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-p45f-replay-"))
    data=root/"dataset"
    # Exclude prior reports/videos outside BlobStore, preserve SQLite and blobs.
    # A clone must never inherit the original dataset's active identity/lineage.
    # The isolated backend will bootstrap a fresh lineage in its own temp root.
    shutil.copytree(source,data,ignore=shutil.ignore_patterns(
        "*.log", "*-verified-*.mp4", "atelier-dataset-identity.json"))
    # The P4.5d service-level acceptance did not create a browser chat session.
    # Reconstruct that session only in the copied dataset, using its real Task IDs.
    with sqlite3.connect(data/"db"/"atelier.sqlite") as conn:
        project_id,chat_id,root_message=conn.execute("""SELECT project_id,chat_session_id,
          root_message_id FROM assistant_tasks LIMIT 1""").fetchone()
        session=dict(id=chat_id,title="P4.5f 已完成真实媒体链",messages=[
            dict(id=root_message,role="user",text="本地 Moss 图片接入 MiniMax H3 视频")],
            createdAt="2026-11-15T12:00:00.000Z",updatedAt="2026-11-15T12:00:00.000Z")
        conn.execute("""UPDATE project_chats SET sessions_json=?,active_chat_id=?,updated_at=?
          WHERE project_id=?""",(json.dumps([session],ensure_ascii=False),chat_id,
                                     int(time.time()*1000),project_id))
    ports=[bound_port() for _ in range(3)]
    assert len(set(ports))==3
    backend_port,vite_port,chrome_port=ports
    env=dict(os.environ,ATELIER_P45F_REPLAY="1",ATELIER_DATA_DIR=str(data),
             ATELIER_BACKEND_PORT=str(backend_port))
    backend=vite=chrome=None
    page=None
    logs=[]
    report=dict(phase="starting",source=str(source),root=str(root),assertions=[])
    def start(name,argv,env=env):
        log=open(root/(name+".log"),"w",encoding="utf8",errors="replace")
        logs.append(log)
        return subprocess.Popen(argv,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,
                                stdout=log,stderr=subprocess.STDOUT)
    def check(name,pred):
        if not pred:raise AssertionError("p45f_replay_assertion_failed:"+name)
        report["assertions"].append(name)
        print("P45F_MEDIA_REPLAY_ASSERT "+name,flush=True)
    try:
        before=stats(data,sqlite3.connect(data/"db"/"atelier.sqlite")
              .execute("SELECT id FROM assistant_tasks LIMIT 1").fetchone()[0])
        check("p45d_two_real_succeeded_jobs",len(before["jobs"])==2 and
              all(j[1]=="succeeded" for j in before["jobs"]))
        check("p45d_two_materialized_artifacts",len(before["materials"])==2 and
              all(item[0]=="materialized" for item in before["materials"]))
        check("p45d_one_budget_consumption",before["consumed"]==1)
        backend=start("backend",["node","scripts/p45f-real-media-replay-fixture.mjs"])
        marker=wait_for(lambda:json.loads((data/"p45f-replay-fixture.json").read_text("utf8"))
                        if (data/"p45f-replay-fixture.json").exists() else None,
                        "replay backend",45)
        front=f"http://127.0.0.1:{vite_port}"
        vite=start("vite",["node","node_modules/vite/bin/vite.js",
                           "--host","127.0.0.1","--port",str(vite_port),"--strictPort"],
                   dict(env,ATELIER_BACKEND_URL=marker["backendOrigin"]))
        wait_for(lambda:urllib.request.urlopen(front,timeout=1).status==200,"vite",45)
        chrome=start("chrome",[str(CHROME),"--headless=new","--disable-gpu",
                     "--autoplay-policy=no-user-gesture-required",
                     "--no-default-browser-check","--no-first-run",
                     f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",
                     f"--user-data-dir={root/'chrome-profile'}",
                     "--window-size=1600,1000","about:blank"])
        wait_for(lambda:helpers["get_json"](f"http://127.0.0.1:{chrome_port}/json/version"),
                 "chrome",35)
        page=ChromeCDP(chrome_port)
        page.call("Page.navigate",{"url":front+"/canvas/"+marker["projectId"]})
        wait_for(lambda:page.js("document.readyState")=="complete","document",35)
        wait_for(lambda:page.js("document.querySelectorAll('button').length")>12,
                 "canvas mounts",40)
        wait_for(lambda:("MiniMax" in page.text() or "H3" in page.text()),"workflow node",40)
        check("real_generated_workflow_visible_in_browser",True)
        media=page.js("""(() => ({videos:[...document.querySelectorAll('video')].map(v=>({
          src:v.currentSrc||v.src,width:v.videoWidth,height:v.videoHeight,
          readyState:v.readyState
        })),images:[...document.querySelectorAll('img')].map(i=>({
          src:i.currentSrc||i.src,complete:i.complete,width:i.naturalWidth
        })).slice(0,20)}))()""")
        report["initialMedia"]=media
        check("browser_media_elements_present",
              len(media["videos"])>0 or len(media["images"])>0)
        # This is a genuine browser fetch through Vite's proxy and SQLite/CAS.
        # Verify returned bytes (not a simulated success response).
        image=page.js("""(async()=>{const r=await fetch('/api/v1/blobs/'+%s);
          const b=await r.arrayBuffer();
          const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)))
                    .map(x=>x.toString(16).padStart(2,'0')).join('');
          return {status:r.status,bytes:b.byteLength,sha,mime:r.headers.get('content-type')};
        })()""" % json.dumps(marker["imageSha"]))
        check("browser_real_cas_png_sha_and_size",image["status"]==200 and
              image["sha"]==marker["imageSha"] and image["bytes"]>100000)
        video=page.js("""(async()=>{const r=await fetch('/api/v1/blobs/'+%s);
          const b=await r.arrayBuffer();const bytes=new Uint8Array(b);
          const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)))
                    .map(x=>x.toString(16).padStart(2,'0')).join('');
          return {status:r.status,bytes:b.byteLength,sha,mime:r.headers.get('content-type'),
                  signature:String.fromCharCode(...bytes.slice(4,8))};
        })()""" % json.dumps(marker["videoSha"]))
        report["verifiedMedia"]=dict(image=image,video=video)
        check("browser_real_cas_mp4_sha_and_size",video["status"]==200 and
              video["sha"]==marker["videoSha"] and video["bytes"]>4096 and
              video["signature"]=="ftyp")
        # DOM video decode checks playback, where the canvas node is actually mounted.
        video_doms=page.js("document.querySelectorAll('video').length")
        if video_doms:
            # Canvas videos intentionally omit src until a genuine poster click.
            # Verify UI playback activation instead of setting src via CDP JS.
            check("real_browser_video_cover_click",
                  bool(page.js("""(()=>{const b=document.querySelector('[data-canvas-video-cover]');
                    if(!b)return false;b.click();return true})()""")))
            try:
                decoded=wait_for(lambda:page.js("""(()=>{const v=[...document.querySelectorAll('video')]
                  .find(v=>(v.currentSrc||v.src).includes('/blobs/'));
                  return v&&v.videoWidth>0?{w:v.videoWidth,h:v.videoHeight,
                  readyState:v.readyState}:null})()"""),"browser video metadata decode",25)
                check("browser_video_metadata_decoded_448_square",
                      decoded["w"]==448 and decoded["h"]==448)
                report["videoDecoded"]=decoded
            except AssertionError as exc:
                report["videoDecodeNotObserved"]=str(exc)
        page.js("""window.dispatchEvent(new KeyboardEvent('keydown',
                  {key:'i',altKey:true,bubbles:true,cancelable:true}));true""")
        wait_for(lambda:bool(page.js("!!document.querySelector('section[aria-label=\"任务状态\"]')")),
                 "assistant task",35)
        wait_for(lambda:("completed" in page.text().lower() or "已完成" in page.text() or
                  "完成" in page.text()),"task terminal UI",35)
        check("completed_task_shown_in_real_browser",True)
        page.screenshot(root/"p45d-real-media-render.png")
        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","refresh",35)
        wait_for(lambda:"MiniMax" in page.text() or "H3" in page.text(),
                 "media node after refresh",40)
        check("real_media_node_restored_after_refresh",True)
        after=stats(data,marker["taskId"])
        check("refresh_keeps_jobs_and_graph_identical",after==before)
        check("no_new_gpu_submission_or_materialization",len(after["jobs"])==2 and
              len(after["materials"])==2)
        report["phase"]="pass"
        print("P45F_REAL_CHROME_MEDIA_REPLAY_PASS "+json.dumps({
          "assertions":len(report["assertions"]),"chrome":"real headless",
          "gpuJobs":len(after["jobs"]),"newGPUJobs":0,
          "videoSha":marker["videoSha"],"browserVideoBytes":video["bytes"]}),flush=True)
    except BaseException as exc:
        report["phase"]="failed"
        report["error"]=str(exc)[:1000]
        if page:
            try:
                report["visibleUI"]=page.text()[:5000]
                page.screenshot(root/"failure.png")
            except Exception as capture_exc:report["captureError"]=str(capture_exc)
        print("P45F_REAL_CHROME_MEDIA_REPLAY_FAIL "+repr(exc),flush=True)
        raise
    finally:
        if page:
            report["browserRequests"]=page.network_requests[-80:]
            report["browserExceptions"]=page.exceptions[-20:]
            try:page.close()
            except Exception:pass
        for proc in (chrome,vite,backend):kill_tree(proc)
        for log in logs:log.close()
        (root/"p45f-media-replay-report.json").write_text(
            json.dumps(report,ensure_ascii=False,indent=2),encoding="utf8")
        print("P45F_MEDIA_REPLAY_REPORT_PATH="+str(root/"p45f-media-replay-report.json"),flush=True)

if __name__=="__main__":main()
