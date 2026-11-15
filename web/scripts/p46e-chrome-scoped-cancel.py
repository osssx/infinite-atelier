"""P4.6e true Chrome button -> isolated Fastify/SQLite -> real Comfy scoped cancel.
Explicit opt-in; only test-owned UUID prompt; no global /interrupt or model GPU.
"""
from __future__ import annotations
import base64
import importlib.util
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

# Import the existing CDP driver without creating repo-local __pycache__.
sys.dont_write_bytecode=True
script_dir=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("p45f_chrome_cdp",script_dir/"p45f-chrome-browser-e2e.py")
driver=importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
CHROME,ROOT=driver.CHROME,driver.ROOT
ChromeCDP,wait_for,bound_port,kill_tree,get_json=(driver.ChromeCDP,driver.wait_for,
 driver.bound_port,driver.kill_tree,driver.get_json)

def send(url,payload=None,timeout=8):
    data=json.dumps(payload).encode() if payload is not None else None
    req=urllib.request.Request(url, data=data,
        headers={"Content-Type":"application/json"} if data else {},method="POST" if data else "GET")
    with urllib.request.urlopen(req,timeout=timeout) as resp:
        return json.load(resp)

def authorized_session(origin):
    # Prewarm a legitimate local session before starting a short-lived prompt.
    opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    with opener.open(origin+"/api/v1/session",timeout=8) as resp:
        session=json.load(resp)
    csrf=session.get("csrfToken")
    if not csrf:raise AssertionError("p46e_local_session_missing_csrf")
    return opener,csrf

def authorized_attach(origin,fixture,session):
    opener,csrf=session
    payload=json.dumps({"token":fixture["token"]}).encode()
    req=urllib.request.Request(origin+"/__p46e/attach",data=payload,method="POST",
         headers={"Content-Type":"application/json","x-atelier-csrf":csrf,"Origin":origin})
    try:
        with opener.open(req,timeout=9) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        # The isolated fixture returns only fixed validation codes, no secrets.
        detail=exc.read(1000).decode('utf8',errors='replace')
        raise AssertionError('p46e_attach_http_'+str(exc.code)+':'+detail) from exc

def db_status(dataset:Path,job_id:str):
    db=sqlite3.connect(str(dataset/"db"/"atelier.sqlite"),timeout=3)
    try:
        row=db.execute("SELECT status,upstream_task_id,lease_owner FROM jobs WHERE id=?",(job_id,)).fetchone()
        return row
    finally: db.close()

def main():
    if sys.argv[1:]!=["--live-scoped-cancel"]:
        raise AssertionError("p46e_requires_explicit_live_scoped_cancel_opt_in")
    if not CHROME.is_file():raise AssertionError("p46e_chrome_missing")
    origin="http://127.0.0.1:8188"
    initial=send(origin+"/queue")
    if initial.get("queue_running") or initial.get("queue_pending"):
        raise AssertionError("p46e_refuses_nonempty_user_queue")
    for key in ["EmptyImage","Sleep","PreviewImage"]:
        if key not in send(origin+"/object_info/"+key):
            raise AssertionError("p46e_required_node_missing:"+key)
    base=Path(tempfile.mkdtemp(prefix="infinite-atelier-p46e-browser-"))
    ports=[bound_port() for _ in range(3)]
    while len(set(ports))!=3: ports=[bound_port() for _ in range(3)]
    backend_port,vite_port,chrome_port=ports
    processes=[];logs=[];page=None;owned_id=None;blocker_id=None
    report={"phase":"starting","root":str(base),"assertions":[],"submitted":0,
            "forbiddenGlobalInterruptCalls":0,"browserRequests":[]}
    def check(key,condition):
        if not condition:raise AssertionError("p46e_assertion_failed:"+key)
        report["assertions"].append(key);print("P46E_CHROME_ASSERT "+key,flush=True)
    def launch(label,args,env):
        log=open(base/(label+".log"),"w",encoding="utf-8",errors="replace")
        logs.append(log)
        proc=subprocess.Popen(args,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,
                            stdout=log,stderr=subprocess.STDOUT)
        processes.append(proc)
        return proc
    try:
        env=dict(os.environ,ATELIER_P46E_BROWSER_E2E="1",ATELIER_DATA_DIR=str(base),
                 ATELIER_BACKEND_PORT=str(backend_port))
        launch("backend",["node","scripts/p46e-browser-cancel-fixture.mjs"],env)
        fixture=wait_for(lambda:json.loads((base/"p46e-fixture.json").read_text("utf8"))
                         if (base/"p46e-fixture.json").exists() else None,
                         "P46E backend fixture",40)
        check("backend_uses_disposable_project",fixture["root"]==str(base) and
              fixture["mode"]=="p46e_real_chrome_scoped_cancel")
        wait_for(lambda:send(fixture["backendOrigin"]+"/health"),"Fastify HTTP",25)
        front=f"http://127.0.0.1:{vite_port}"
        launch("vite",["node","node_modules/vite/bin/vite.js","--host","127.0.0.1",
                       "--port",str(vite_port),"--strictPort"],
               dict(env,ATELIER_BACKEND_URL=fixture["backendOrigin"]))
        wait_for(lambda:urllib.request.urlopen(front,timeout=1).status==200,"Vite HTTP",55)
        launch("chrome",[str(CHROME),"--headless=new","--disable-gpu",
                         "--no-first-run","--no-default-browser-check",
                         f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",
                         f"--user-data-dir={base.parent/(base.name+'-profile')}",
                         "--window-size=1440,940","about:blank"],env)
        wait_for(lambda:get_json(f"http://127.0.0.1:{chrome_port}/json/version"),
                 "Chrome CDP",35)
        page=ChromeCDP(chrome_port)
        page.call("Page.navigate",{"url":front+"/canvas/"+fixture["projectId"]})
        wait_for(lambda:page.js("document.readyState")=="complete","Chrome app ready",55)
        wait_for(lambda:page.js("!!document.querySelector('button[aria-label=\\\"任务历史\\\"]')"),
                 "Chrome real task history control",55)
        check("loaded_real_canvas_page",page.js("location.pathname")=="/canvas/"+fixture["projectId"])
        # Ensure the real browser is hydrated BEFORE submitting the running test prompt.
        wait_for(lambda:page.js("document.querySelectorAll('button').length")>12,
                 "hydrated React canvas",50)
        # Preload the real Job History drawer and its lazy React module BEFORE
        # starting a short-lived remote prompt. No user Job is running yet.
        check("preloaded_real_job_history_drawer",bool(page.js(
              "(() => {const b=document.querySelector('button[aria-label=\\\"任务历史\\\"]');"
              "if(!b||b.disabled)return false;b.click();return true})()")))
        wait_for(lambda:"停止此 ComfyUI 任务" in page.text(),
                 "queued fixture Job history fully hydrated",55)
        # Prime the actual AntD confirmation while the fixture Job is local
        # queued; dismiss without sending any cancellation request.
        check("preloaded_cancel_confirmation",page.click("停止此 ComfyUI 任务"))
        wait_for(lambda:"保留任务" in page.text(),"preloaded cancel modal",15)
        check("dismissed_preflight_cancel_without_remote_job",page.click("保留任务"))
        wait_for(lambda:"停止此 ComfyUI 任务" in page.text(),"cancel button restored",15)
        attach_session=authorized_session(fixture["backendOrigin"])
        q=send(origin+"/queue")
        check("no_foreign_remote_prompt_before_submit",
              len(q.get("queue_running",[]))+len(q.get("queue_pending",[]))==0)
        # Test-only Fastify backend submits its ONE owned prompt, then saves
        # exactly the ID returned by Comfy. It never queries the busy queue.
        attached=authorized_attach(fixture["backendOrigin"],fixture,attach_session)
        owned_id=attached.get("remoteTaskId")
        blocker_id=attached.get("blockerId")
        check("two_owned_tiny_comfy_prompts_submitted",
              isinstance(owned_id,str) and len(owned_id)==36 and
              isinstance(blocker_id,str) and len(blocker_id)==36 and owned_id!=blocker_id)
        report["submitted"]=2
        check("coordinator_job_binds_exact_owned_remote",
              attached.get("attached") is True and attached["jobId"]==fixture["jobId"])
        check("only_owned_prompt_attached_from_submit_receipt",
              db_status(base,fixture["jobId"])[1]==owned_id)
        # Intentional queued-on-screen -> running-in-DB race. Immediately
        # click the already-loaded real Stop button; coordinator decides from
        # the latest persisted Job status. No blocking GET /queue here.
        check("active_comfy_job_shows_stop_in_browser",
              "停止此 ComfyUI 任务" in page.text())
        check("clicked_scoped_cancel_button",page.click("停止此 ComfyUI 任务"))
        wait_for(lambda:"确认停止此任务" in page.text(),"scoped cancel confirmation",15)
        check("confirmed_user_scoped_cancel",page.click("确认停止此任务"))
        job_result=wait_for(lambda:db_status(base,fixture["jobId"])
                          if db_status(base,fixture["jobId"])[0]=="cancelled" else None,
                          "SQLite Job terminal cancelled",35)
        wait_for(lambda:"已取消" in page.text(),"React job history confirmed cancellation",20)
        report["afterCancelUI"]=(page.text() or "")[-1500:]
        check("sqlite_job_cancelled_and_unleased",
              job_result==( "cancelled",owned_id,None))
        check("ui_displays_confirmed_cancelled", "已取消" in page.text())
        check("stop_button_no_longer_available",
              "停止此 ComfyUI 任务" not in page.text())
        # Target remained pending behind our own disposable blocker.
        # Cleanup sends only a per-ID cancellation, never global interrupt.
        blocker_response=send(origin+"/api/jobs/"+blocker_id+"/cancel",{})
        check("scoped_blocker_cleanup_returned_boolean",
              isinstance(blocker_response.get("cancelled"),bool))
        target_history=send(origin+"/history/"+owned_id).get(owned_id)
        check("cancelled_pending_target_never_executed",target_history is None)
        check("exactly_two_disposable_prompts_submitted",report["submitted"]==2)
        check("no_global_interrupt",report["forbiddenGlobalInterruptCalls"]==0)
        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","Chrome reload",45)
        wait_for(lambda:page.js("!!document.querySelector('button[aria-label=\\\"任务历史\\\"]')"),
                 "history reopen after refresh",45)
        check("reopened_job_history_after_browser_reload",bool(page.js(
              "(() => {const b=document.querySelector('button[aria-label=\\\"任务历史\\\"]');"
              "if(!b)return false;b.click();return true})()")))
        wait_for(lambda:"已取消" in page.text(),"durable cancelled after refresh",30)
        check("reload_preserves_cancelled_job_and_no_stop",
              "已取消" in page.text() and "停止此 ComfyUI 任务" not in page.text())
        check("reload_has_no_second_remote_generation",
              report["submitted"]==2)
        page.screenshot(base/"after-reload.png")
        report["phase"]="pass"
        report["summary"]={"assertions":len(report["assertions"]),
                           "remoteCase":"pending_scoped_cancel",
                           "cancelled":True,"submitted":2,"globalInterrupts":0}
        print("P46E_REAL_CHROME_SCOPED_CANCEL_PASS "+
              json.dumps(report["summary"],ensure_ascii=True),flush=True)
    except BaseException as error:
        report["phase"]="failed";report["error"]=str(error)
        print("P46E_REAL_CHROME_SCOPED_CANCEL_FAIL "+str(error),flush=True)
        raise
    finally:
        # Fail-closed cleanup: only this run's ID; no global interrupt.
        for cleanup_id in [owned_id,blocker_id]:
            if cleanup_id:
                try:send(origin+"/api/jobs/"+cleanup_id+"/cancel",{},timeout=10)
                except Exception as error:
                    report.setdefault("cleanupWarnings",[]).append(str(error))
        if page is not None:
            try:report["browserRequests"]=page.network_requests[-70:]
            except Exception:pass
            try:page.close()
            except Exception:pass
        for proc in reversed(processes):kill_tree(proc)
        for f in logs:f.close()
        (base/"p46e-browser-report.json").write_text(
             json.dumps(report,ensure_ascii=False,indent=2),encoding="utf8")
        print("P46E_BROWSER_REPORT_PATH="+str(base/"p46e-browser-report.json"),flush=True)
if __name__=="__main__":main()
