"""P4.5f real Chrome CDP -> Vite -> Fastify/SQLite UI acceptance.

Runs ONLY an isolated disposable project and browser profile, with backend
autoDispatch=False. Never calls Comfy /prompt, never touches user assets.
Python prerequisites: requests not required; websocket-client on test host.
Usage: python scripts/p45f-chrome-browser-e2e.py
"""
from __future__ import annotations
import base64
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

try:
    import websocket
except ImportError as exc:
    raise SystemExit("P45F_BROWSER_NO_WEBSOCKET_CLIENT: install websocket-client in test host") from exc

CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
ROOT = Path(__file__).resolve().parents[1]
def bound_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])

def get_json(url: str, timeout: float=2.5):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.load(resp)

def wait_for(fn, label: str, seconds: float=35):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        try:
            item = fn()
            if item:
                return item
        except Exception as exc:
            last = str(exc)[:200]
        time.sleep(.2)
    raise AssertionError(f"p45f_wait_timeout:{label} last={last}")

class ChromeCDP:
    def __init__(self, port: int):
        listing = get_json(f"http://127.0.0.1:{port}/json/list")
        target = next(p for p in listing if p.get("type") == "page")
        self.ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=10,
                                              origin=f"http://127.0.0.1:{port}")
        self.next_id = 0
        self.responses = []
        self.network_requests = []
        self.exceptions = []
        for cmd in ["Page.enable", "Runtime.enable", "Network.enable"]:
            self.call(cmd, {})

    def call(self, method: str, params: dict | None = None, timeout: float=18):
        self.next_id += 1
        target = self.next_id
        self.ws.send(json.dumps({"id": target, "method": method,
                                 "params": params or {}}, ensure_ascii=False))
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.ws.settimeout(max(.1, end-time.monotonic()))
            event = json.loads(self.ws.recv())
            if event.get("id") == target:
                if "error" in event:
                    raise AssertionError(f"cdp:{method}:{event['error']}")
                return event.get("result", {})
            kind = event.get("method")
            if kind == "Network.requestWillBeSent":
                req = event.get("params", {}).get("request", {})
                url = req.get("url", "")
                if "/api/v1/" in url:
                    self.network_requests.append({
                        "method": req.get("method"), "path":url.split("/api/v1/",1)[-1],
                        "postData": req.get("postData","")[:700]
                    })
            if kind == "Runtime.exceptionThrown":
                self.exceptions.append(str(event.get("params",{}).get("exceptionDetails",{}).get("text",""))[:300])
        raise TimeoutError("cdp_no_response:"+method)

    def js(self, expression: str):
        out = self.call("Runtime.evaluate", {
            "expression": expression, "returnByValue": True,
            "awaitPromise": True, "userGesture": True
        })
        if out.get("exceptionDetails"):
            raise AssertionError("browser_js_error:"+str(out["exceptionDetails"])[:600])
        return out.get("result",{}).get("value")

    def click(self, text: str) -> bool:
        return bool(self.js("""(() => {
            const text = %s;
            const matches = [...document.querySelectorAll('button')]
              .filter(el => (el.innerText||el.textContent||'').trim() === text);
            const el = matches.find(el => el.getClientRects().length>0&&!el.disabled);
            if(!el)return false;
            el.click();
            return true;
        })()""" % json.dumps(text,ensure_ascii=False)))

    def text(self):
        return self.js("document.body?.innerText?.slice(0,18000)||''") or ""

    def screenshot(self, dest: Path):
        result = self.call("Page.captureScreenshot", {"format":"png","captureBeyondViewport":False})
        dest.write_bytes(base64.b64decode(result["data"]))

    def close(self):
        self.ws.close()

def task_content_contains(page: ChromeCDP, needle: str):
    # Task expansion is intentionally reset by the app when Task detail
    # hydration changes. An automated human click must wait for stable React
    # hydration instead of toggling a control before its state settles.
    collapsed=page.js("document.getElementById('canvas-assistant-task-content')?.hidden")
    if collapsed:
        page.click("任务详情")
    return needle in page.text()

def kill_tree(proc: subprocess.Popen | None):
    if proc is None or proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID",str(proc.pid)],
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=12)
    else:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill()

def main():
    if not CHROME.exists():
        raise AssertionError("chrome_executable_missing")
    scenario = sys.argv[1] if len(sys.argv)>1 else "grant"
    if scenario not in ("grant","recovery"):
        raise AssertionError("p45f_browser_scenario_must_be_grant_or_recovery")
    root = Path(tempfile.mkdtemp(prefix="infinite-atelier-p45f-browser-"))
    data = root / "dataset"
    # Fixture validates basename against the temp root prefix. Use the root
    # itself as a fresh SQLite/CAS store; keep Chrome under a sibling folder.
    data = root
    backend_port, vite_port, chrome_port = bound_port(), bound_port(), bound_port()
    assert len({backend_port,vite_port,chrome_port})==3
    backend = vite = chrome = None
    page = None
    report={"phase":"starting","root":str(root),"scenario":scenario,
            "test":"chrome_real_ui_once_grant_refresh_revoke_no_gpu",
            "chrome":None,"browserRequests":[],"assertions":[]}
    log_files=[]
    def launch(label:str,args:list[str],env:dict,workdir:Path|None=None):
        f = open(root / f"{label}.log", "w",encoding="utf8",errors="replace")
        log_files.append(f)
        return subprocess.Popen(args,cwd=workdir or ROOT,env=env,
            stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT)
    def check(desc:str, condition:bool):
        if not condition:raise AssertionError("p45f_assertion_failed:"+desc)
        report["assertions"].append(desc)
        print("P45F_BROWSER_ASSERT",desc,flush=True)
    try:
        env=dict(os.environ,ATELIER_P45F_BROWSER_E2E="1",
                 ATELIER_DATA_DIR=str(data),ATELIER_BACKEND_PORT=str(backend_port),
                 ATELIER_P45F_BROWSER_SCENARIO=scenario)
        backend=launch("backend",["node","scripts/p45f-browser-fixture.mjs"],env)
        fixture=wait_for(lambda:json.loads((root/"p45f-fixture.json").read_text("utf8"))
                         if (root/"p45f-fixture.json").exists() else None,"backend fixture",45)
        wait_for(lambda:urllib.request.urlopen(fixture["backendOrigin"]+"/health",
                                               timeout=1).status==200,"backend HTTP",25)
        front=f"http://127.0.0.1:{vite_port}"
        vite=launch("vite",["node","node_modules/vite/bin/vite.js",
                         "--host","127.0.0.1","--port",str(vite_port),"--strictPort"],
                    dict(env,ATELIER_BACKEND_URL=fixture["backendOrigin"]))
        wait_for(lambda:urllib.request.urlopen(front,timeout=1).status==200,"Vite HTTP",55)
        chrome=launch("chrome",[str(CHROME),"--headless=new","--disable-gpu",
            "--no-default-browser-check","--no-first-run",
            f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",
            f"--user-data-dir={root.parent/(root.name+'-chrome-profile')}",
            "--window-size=1440,940","about:blank"],env,ROOT)
        version=wait_for(lambda:get_json(f"http://127.0.0.1:{chrome_port}/json/version"),
                         "Chrome CDP",35)
        report["chrome"]=version.get("Browser")
        page=ChromeCDP(chrome_port)
        page.call("Page.navigate",{"url":front+"/canvas/"+fixture["projectId"]})
        # The full product SPA, not a replacement test component.
        wait_for(lambda:"canvas" in (page.js("document.location.pathname") or ""), "product route")
        wait_for(lambda:page.js("document.readyState")=="complete","page complete",55)
        wait_for(lambda:page.js("document.querySelectorAll('button').length")>12,"canvas UI",55)
        check("loaded_real_project_page",page.js("location.pathname")=="/canvas/"+fixture["projectId"])
        # The product binds Alt+I to the assistant.
        page.js("""window.dispatchEvent(new KeyboardEvent('keydown',
          {key:'i',altKey:true,bubbles:true,cancelable:true}));true""")
        wait_for(lambda:bool(page.js("!!document.querySelector('section[aria-label=\"任务状态\"]')")),
                 "assistant task panel",40)
        if page.click("任务详情"):
            time.sleep(.4)
        if scenario!="recovery":
            wait_for(lambda:bool(page.js(
                "!!document.querySelector('input[aria-label=\"确认本地媒体链自动绑定与生成\"]')")),
                     "local media consent widget",40)
        if scenario=="recovery":
            # The fixture used the production Task planner, grant, canvas
            # executor and media materialization, but its predecessor image
            # is explicitly synthetic. The real browser resumes the existing
            # waiting_approval video Step; dispatch remains disabled.
            check("preexisting_trusted_fixture_image_job",db_stats(data,fixture)["jobs"]==1)
            check("fixture_media_grant_still_unconsumed",
                  db_stats(data,fixture)["granted"]==1 and
                  db_stats(data,fixture)["consumed"]==0)
            wait_for(lambda:task_content_contains(
                page,"使用原授权恢复一次本地 ComfyUI 生成"),
                "frozen Comfy Step recovery UI",35)
            page.screenshot(root/"recovery-before-refresh.png")
            check("refresh_does_not_create_new_video_job",db_stats(data,fixture)["jobs"]==1)
            page.call("Page.reload",{"ignoreCache":True})
            wait_for(lambda:page.js("document.readyState")=="complete","frozen Step reload",40)
            wait_for(lambda:page.js("document.querySelectorAll('button').length")>12,
                     "canvas mounted after frozen Step reload",40)
            page.js("""window.dispatchEvent(new KeyboardEvent('keydown',
                {key:'i',altKey:true,bubbles:true,cancelable:true}));true""")
            wait_for(lambda:bool(page.js(
                "!!document.querySelector('section[aria-label=\"任务状态\"]')")),
                "reopened frozen media Task panel",40)
            wait_for(lambda:task_content_contains(
                page,"使用原授权恢复一次本地 ComfyUI 生成"),
                "persisted frozen Step with same grant",35)
            check("waiting_video_step_survives_real_browser_reload",
                  db_stats(data,fixture)["jobs"]==1)
            check("single_explicit_recovery_click",page.click(
                "使用原授权恢复一次本地 ComfyUI 生成"))
            wait_for(lambda:db_stats(data,fixture)["jobs"]==2,
                     "one durable authorized downstream Job",35)
            check("original_grant_consumed_exactly_once",
                  db_stats(data,fixture)["consumed"]==1)
            check("dispatch_disabled_no_remote_gpu_submission",
                  db_stats(data,fixture)["submitBarriers"]==0)
            page.screenshot(root/"recovery-authorized-enqueue.png")
            page.call("Page.reload",{"ignoreCache":True})
            wait_for(lambda:page.js("document.readyState")=="complete",
                     "recovery completion reload",35)
            check("recovery_does_not_reenqueue_after_reload",
                  db_stats(data,fixture)["jobs"]==2 and
                  db_stats(data,fixture)["consumed"]==1)
            writes=[q for q in page.network_requests if q["method"]=="POST"]
            check("one_real_authorized_step_enqueue_post",
                  sum(q["path"].endswith("/enqueue-authorized") for q in writes)==1)
            check("no_duplicate_enqueue_or_comfy_prompt",
                  not any(q["path"].endswith("/enqueue") or "/prompt" in q["path"]
                      for q in writes))
            report.update(phase="pass",summary={"scenario":"recovery",
                "jobs":2,"sourceFixtureSynthetic":True,
                "mediaAuthorizedJobs":1,"grantConsumed":1,"comfyGpuSubmits":0,
                "chrome":report["chrome"],"fullProductPage":True,
                "screenshots":["recovery-before-refresh.png",
                               "recovery-authorized-enqueue.png"]})
            print("P45F_REAL_CHROME_RECOVERY_PASS "+
                  json.dumps(report["summary"],ensure_ascii=False),flush=True)
            return
        check("real_assistant_panel_and_media_consent_widget",True)
        check("zero_pregrant_jobs",db_stats(data,fixture)["jobs"]==0)
        page.js("""document.querySelector('input[aria-label="确认本地媒体链自动绑定与生成"]').click()""")
        wait_for(lambda:bool(page.js("""[...document.querySelectorAll('button')].some(
            b=>(b.innerText||'').trim()==='批准唯一媒体连线及一次 ComfyUI 生成'&&!b.disabled)""")),
                 "consent checkbox enables button",20)
        check("click_confirmed_media_grant_button",page.click("批准唯一媒体连线及一次 ComfyUI 生成"))
        wait_for(lambda:db_stats(data,fixture)["granted"]==1,"grant persisted in SQLite",35)
        check("grant_persisted_zero_jobs",db_stats(data,fixture)["jobs"]==0)
        page.screenshot(root/"grant-approved.png")
        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","reloaded document",40)
        wait_for(lambda:page.js("document.querySelectorAll('button').length")>12,"reloaded canvas",40)
        page.js("""window.dispatchEvent(new KeyboardEvent('keydown',
           {key:'i',altKey:true,bubbles:true,cancelable:true}));true""")
        wait_for(lambda:bool(page.js("!!document.querySelector('section[aria-label=\"任务状态\"]')")),
                 "assistant panel after reload",40)
        wait_for(lambda:task_content_contains(page,"撤销剩余自动入队授权"),
                 "persisted grant UI after reload",40)
        check("reloaded_grant_visible",True)
        # Simulate a browser-side network outage while revoking. The HTTP
        # request must not reach SQLite, and the UI must not retry when back.
        page.call("Network.emulateNetworkConditions",{"offline":True,"latency":0,
            "downloadThroughput":0,"uploadThroughput":0})
        check("offline_revoke_attempt_via_real_button",
              page.click("撤销剩余自动入队授权"))
        wait_for(lambda:"撤销授权失败" in page.text(),"offline revocation error surfaced",18)
        check("offline_request_never_revoked_grant",db_stats(data,fixture)["revoked"]==0)
        page.call("Network.emulateNetworkConditions",{"offline":False,"latency":0,
            "downloadThroughput":-1,"uploadThroughput":-1})
        time.sleep(.8)
        check("reconnection_does_not_retry_failed_revoke",
              db_stats(data,fixture)["revoked"]==0)
        check("revoke_grant_through_real_button",page.click("撤销剩余自动入队授权"))
        wait_for(lambda:db_stats(data,fixture)["revoked"]==1,"grant revoked in SQLite",35)
        check("revoke_keeps_zero_jobs",db_stats(data,fixture)["jobs"]==0)
        page.screenshot(root/"grant-revoked.png")
        # Revoked grant must not be silently re-used or cause auto generation.
        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","post-revocation reload",40)
        wait_for(lambda:page.js("document.querySelectorAll('button').length")>12,
                 "post-revocation React canvas mounted",45)
        check("grant_revocation_durable",db_stats(data,fixture)["revoked"]==1)
        check("no_comfy_prompt_post",db_stats(data,fixture)["jobs"]==0)
        if not page.js("!!document.querySelector('section[aria-label=\"任务状态\"]')"):
            page.js("""window.dispatchEvent(new KeyboardEvent('keydown',
              {key:'i',altKey:true,bubbles:true,cancelable:true}));true""")
        wait_for(lambda:bool(page.js("!!document.querySelector('section[aria-label=\"任务状态\"]')")),
                 "task panel after revocation",35)
        wait_for(lambda:task_content_contains(page,"结束记录"),
                 "task cancel control",25)
        check("cancel_record_via_real_browser",page.click("结束记录"))
        wait_for(lambda:db_stats(data,fixture)["taskStatus"]=="cancelled",
                 "Task cancellation persisted",25)
        check("browser_task_cancel_no_job",db_stats(data,fixture)["jobs"]==0)
        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","cancelled Task reload",30)
        check("cancel_intent_survives_reload",db_stats(data,fixture)["taskStatus"]=="cancelled")
        writes=[q for q in page.network_requests if q["method"]=="POST" and
                any(t in q["path"] for t in ("run-budget","enqueue","/prompt","/cancel"))]
        check("exactly_grant_and_revoke_post",
              len([q for q in writes if q["path"].endswith("/run-budget")])==1 and
              len([q for q in writes if q["path"].endswith("/revoke")])>=1 and
              len([q for q in writes if q["path"].endswith("/cancel")])==1 and
              not any("/enqueue" in q["path"] for q in writes))
        report.update(phase="pass",summary={"grant":1,"revoked":1,"jobs":0,
            "browserOfflineRevokePrevented":True,"taskCancelled":True,
            "chromium":report["chrome"],"fullProductPage":True,
            "screenshots":["grant-approved.png","grant-revoked.png"]})
        print("P45F_REAL_CHROME_BROWSER_PASS "+json.dumps(report["summary"],ensure_ascii=False),flush=True)
    except BaseException as exc:
        report.update(phase="failed",error=str(exc)[:900])
        if page:
            try:
                report["visibleUI"]=page.text()[:5200]
                page.screenshot(root/"failure.png")
            except Exception as capture_exc:
                report["captureError"]=str(capture_exc)[:250]
        print("P45F_REAL_CHROME_BROWSER_FAIL "+repr(exc),flush=True)
        raise
    finally:
        if page:
            report["browserRequests"]=page.network_requests[-75:]
            report["browserExceptions"]=page.exceptions[-15:]
            try:page.close()
            except Exception:pass
        for proc in [chrome,vite,backend]:
            kill_tree(proc)
        for log in log_files:
            log.close()
        (root/"p45f-browser-report.json").write_text(
            json.dumps(report,ensure_ascii=False,indent=2),encoding="utf8")
        print("P45F_BROWSER_REPORT_PATH="+str(root/"p45f-browser-report.json"),flush=True)

def db_stats(root:Path,fixture:dict):
    con=sqlite3.connect(f"file:{(root/'db'/'atelier.sqlite').as_posix()}?mode=ro",uri=True,timeout=3)
    try:
        jobs=con.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
        events=con.execute("""SELECT kind,payload_json FROM assistant_task_events
          WHERE task_id=? AND kind IN('run_budget_granted','run_budget_revoked','run_budget_consumed')""",
          (fixture["taskId"],)).fetchall()
        granted=sum(k=="run_budget_granted" for k,_ in events)
        revoked=sum("revok" in k for k,_ in events)
        consumed=sum(k=="run_budget_consumed" for k,_ in events)
        submit_barriers=con.execute("SELECT COUNT(*) FROM job_events WHERE kind='job_submit_barrier'").fetchone()[0]
        task_status=con.execute("SELECT status FROM assistant_tasks WHERE id=?",
                                (fixture["taskId"],)).fetchone()
        return {"jobs":jobs,"granted":granted,"revoked":revoked,
                "taskStatus":task_status[0] if task_status else None,
                "consumed":consumed,"submitBarriers":submit_barriers,
                "eventKinds":[k for k,_ in events]}
    finally:
        con.close()

if __name__=="__main__":
    main()
