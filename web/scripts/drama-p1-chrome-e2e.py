"""P1 actual Chrome SPA test against an isolated mock-model backend and temp CAS."""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/"scripts"/"p45f-chrome-browser-e2e.py"
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location("p45f_cdp",BASE)
cdp=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=cdp
spec.loader.exec_module(cdp)
ChromeCDP=cdp.ChromeCDP
wait_for=cdp.wait_for
kill_tree=cdp.kill_tree

def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1",0))
        return s.getsockname()[1]
def jseval(page,source):
    return page.js(source)
def node_button(page,node_id,label):
    return bool(jseval(page,"""(() => {
      const root=document.querySelector('[data-node-id=%s]');
      const target=[...(root?.querySelectorAll('button')||[])].find(b=>(b.innerText||b.textContent||'').trim()===%s);
      if(!target||target.disabled)return false;
      target.click();return true;
    })()"""%(json.dumps(node_id),json.dumps(label,ensure_ascii=False))))
def choose_episode(page):
    return bool(jseval(page,"""(() => {
      const root=document.querySelector('[data-node-id="board"]');
      const select=root?.querySelector('select[aria-label="生成范围：剧集"]');
      if(!select)return false;
      const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      setter.call(select,'ep-two');
      select.dispatchEvent(new Event('change',{bubbles:true}));
      return select.value==='ep-two';
    })()"""))
def graph(page,pid):
    return jseval(page,"""(async()=>{
      const res=await fetch('/api/v1/projects/%s',{credentials:'same-origin'});
      return {ok:res.ok,data:await res.json()};
    })()"""%pid)
def find_node(g,node_id):
    return next(n for n in g["document"]["nodes"] if n["id"]==node_id)
def click_run_candidate(page):
    return bool(jseval(page,"""(() => {
      const board=document.querySelector('[data-node-id="board"]');
      const detail=[...(board?.querySelectorAll('details')||[])].find(d=>
         (d.querySelector(':scope > summary')?.textContent||'').includes('ready'));
      if(!detail)return false;
      detail.open=true;
      detail.dispatchEvent(new Event('toggle',{bubbles:true}));
      const button=[...detail.querySelectorAll('button')].find(b=>(b.textContent||'').trim()==='采用到草案');
      if(!button||button.disabled)return false;button.click();return true;
    })()"""))
def http_json(url):
    with urllib.request.urlopen(url,timeout=2) as r:return json.load(r)
def main():
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-drama-p1-browser-"))
    chrome_profile=root.parent/(root.name+"-chrome-profile")
    backend_port,vite_port,chrome_port=port(),port(),port()
    env=dict(os.environ,ATELIER_DATA_DIR=str(root),ATELIER_DRAMA_P1_BROWSER_E2E="1",
             ATELIER_BACKEND_PORT=str(backend_port))
    backend=vite=chrome=page=None
    logs=[]
    report={"scope":"isolated P1 full product UI","assertions":[],"model":"deterministic mock","onlineProviderPosts":0}
    def launch(name,argv,environment):
        log=open(root/(name+".log"),"w",encoding="utf-8",errors="replace")
        logs.append(log)
        return subprocess.Popen(argv,cwd=ROOT,env=environment,
            stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
    def check(name,condition):
        if not condition:raise AssertionError(name)
        report["assertions"].append(name)
        print("P1_CHROME_ASSERT "+name,flush=True)
    try:
        backend=launch("backend",["node","scripts/drama-p1-browser-fixture.mjs"],env)
        fixture=wait_for(lambda:json.loads((root/"p1-fixture.json").read_text("utf-8"))
                         if (root/"p1-fixture.json").exists() else None,"fixture startup",45)
        wait_for(lambda:urllib.request.urlopen(fixture["backendOrigin"]+"/health",timeout=2).status==200,
                 "backend health",20)
        front=f"http://127.0.0.1:{vite_port}"
        vite=launch("vite",["node","node_modules/vite/bin/vite.js",
              "--host","127.0.0.1","--port",str(vite_port),"--strictPort"],
              dict(env,ATELIER_BACKEND_URL=fixture["backendOrigin"]))
        wait_for(lambda:urllib.request.urlopen(front,timeout=2).status==200,"vite frontend",55)
        chrome=launch("chrome",[str(cdp.CHROME),"--headless=new","--disable-gpu",
             "--no-default-browser-check","--no-first-run",
             f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",
             f"--user-data-dir={chrome_profile}","--window-size=1720,1050","about:blank"],env)
        wait_for(lambda:http_json(f"http://127.0.0.1:{chrome_port}/json/version"),"chrome CDP",35)
        page=ChromeCDP(chrome_port)
        pid=fixture["projectId"]
        page.call("Page.navigate",{"url":front+"/canvas/"+pid})
        wait_for(lambda:page.js("document.readyState")=="complete","page load",55)
        wait_for(lambda:len(page.js("Array.from(document.querySelectorAll('[data-node-id]')).map(x=>x.dataset.nodeId)") or [])>=4,
                 "drama canvas graph",55)
        check("real_canvas_project_loaded",page.js("location.pathname")=="/canvas/"+pid)
        first=graph(page,pid)
        check("loaded_backend_project",first["ok"] is True)
        original=find_node(first["data"],"first-config")
        original_links=[e for e in first["data"]["document"]["connections"] if e["toNodeId"]=="first-config"]

        # P3.3: browse the off-graph asset/episode summaries while full editor
        # content is still unloaded; this must not expand whole drama bodies.
        for stage,count,label in (("assets",2,"资产"),("episodes",2,"剧集")):
            def open_scope():
                return bool(page.js("""(() => {
                  const root=document.querySelector('[data-node-id=%s]');
                  const button=root?.querySelector('[aria-label=%s] button[aria-expanded]');
                  if(!button)return false;
                  if(button.getAttribute('aria-expanded')==='false')button.click();
                  return true;
                })()"""%(json.dumps(stage),json.dumps(label+"独立存储分页浏览",ensure_ascii=False))))
            check("p33_lazy_"+stage+"_browse_click",bool(wait_for(open_scope,"P3.3 open scope "+stage,25)))
            def scope_loaded():
                return bool(page.js("""(() => {
                   const root=document.querySelector('[data-node-id=%s]');
                   const browser=root?.querySelector('[aria-label=%s]');
                   return !!browser&&(browser.textContent||'').includes(%s);
                })()"""%(json.dumps(stage),json.dumps(label+"独立存储分页浏览",ensure_ascii=False),
                        json.dumps(label+"共 "+str(count)+" 项",ensure_ascii=False))))
            check("p33_lazy_"+stage+"_shows_count_without_editor",bool(wait_for(scope_loaded,"P3.3 count "+stage,25)))
            check("p33_lazy_"+stage+"_editor_still_unloaded",bool(page.js("""(() => {
                const root=document.querySelector('[data-node-id=%s]');
                return [...(root?.querySelectorAll('button')||[])].some(
                  btn=>(btn.textContent||'').trim()==='打开创作内容');
            })()"""%json.dumps(stage))))

        # P3.3d: perform real controlled-input edits in the compact node
        # browser, not by calling the API directly. Afterwards the canvas
        # state must rehydrate the updated authoritative payload.
        for stage,label,field,updated in (
            ("assets","资产","描述","浏览器局部修改资产描述"),
            ("episodes","剧集","剧情概要","浏览器局部修改第一集概要")
        ):
            def open_draft():
                return bool(page.js("""(() => {
                    const root=document.querySelector('[data-node-id=%s]');
                    const browser=root?.querySelector('[aria-label=%s]');
                    const checkbox=browser?.querySelector('input[type="checkbox"]');
                    if(!checkbox)return false;
                    if(!checkbox.checked)checkbox.click();
                    return checkbox.checked;
                })()"""%(json.dumps(stage),json.dumps(label+"独立存储分页浏览",ensure_ascii=False))))
            check("p33d_"+stage+"_draft_toggle",bool(wait_for(open_draft,"P3.3d draft "+stage,25)))
            def editor_open():
                return bool(page.js("""(() => {
                    const root=document.querySelector('[data-node-id=%s]');
                    const browser=root?.querySelector('[aria-label=%s]');
                    const entry=browser?.querySelector('details');
                    if(!entry)return false;
                    if(!entry.open)entry.open=true;
                    const editor=entry.querySelector('details[aria-label="编辑当前资产或剧集条目"]');
                    if(!editor)return false;
                    if(!editor.open)editor.open=true;
                    return [...editor.querySelectorAll('label')].some(l=>
                        (l.textContent||'').includes(%s)&&!!l.querySelector('textarea'));
                })()"""%(json.dumps(stage),json.dumps(label+"独立存储分页浏览",ensure_ascii=False),
                        json.dumps(field,ensure_ascii=False))))
            check("p33d_"+stage+"_editor_ready",bool(wait_for(editor_open,"P3.3d editor "+stage,25)))
            check("p33d_"+stage+"_react_input",bool(page.js("""(() => {
                const root=document.querySelector('[data-node-id=%s]');
                const editor=root?.querySelector('details[aria-label="编辑当前资产或剧集条目"]');
                const label=[...(editor?.querySelectorAll('label')||[])].find(l=>
                    (l.textContent||'').includes(%s));
                const input=label?.querySelector('textarea');
                if(!input)return false;
                const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
                setter.call(input,%s);
                input.dispatchEvent(new Event('input',{bubbles:true}));
                return true;
            })()"""%(json.dumps(stage),json.dumps(field,ensure_ascii=False),
                     json.dumps(updated,ensure_ascii=False)))))
            def click_draft_save():
                return bool(page.js("""(() => {
                    const root=document.querySelector('[data-node-id=%s]');
                    const editor=root?.querySelector('details[aria-label="编辑当前资产或剧集条目"]');
                    const button=[...(editor?.querySelectorAll('button')||[])].find(b=>
                        (b.textContent||'').includes('保存当前条目草案'));
                    if(!button||button.disabled)return false;
                    button.click();
                    return true;
                })()"""%json.dumps(stage)))
            check("p33d_"+stage+"_save_clicked",bool(wait_for(click_draft_save,"P3.3d save "+stage,25)))
            def persisted_draft():
                g=graph(page,pid)
                if not g.get("ok"):return None
                try:
                    item=json.loads(find_node(g["data"],stage)["metadata"]["dramaDraft"])
                    chosen=item["assets"][0] if stage=="assets" else item["episodes"][0]
                    actual=chosen["description"] if stage=="assets" else chosen["synopsis"]
                    return g if actual==updated else None
                except Exception:return None
            check("p33d_"+stage+"_authoritative_saved",bool(wait_for(persisted_draft,
                "P3.3d saved "+stage,35)))
        check("p33d_original_config_unchanged",find_node(graph(page,pid)["data"],"first-config")==original)
        # The compact graph uses lazy creative payloads. Open the genuine node panel before editing.
        for name in ("assets","episodes","board"):
            if node_button(page,name,"打开创作内容"):
                wait_for(lambda n=name:bool(page.js(
                  "(document.querySelector('[data-node-id=%s]')?.innerText||'').includes('确认阶段')"%json.dumps(n))),
                  "load "+name+" content",25)
        check("story_and_episode_nodes_visible",bool(page.js(
              "!!document.querySelector('[data-node-id=\"episodes\"]')&&!!document.querySelector('[data-node-id=\"story\"]')")))
        wait_for(lambda:choose_episode(page),"episode selector",25)
        check("episode_two_selected",True)
        check("p2_event_identity_edit_action_visible",bool(page.js("""(() => {
            const root=document.querySelector('[data-node-id="episodes"]');
            return [...(root?.querySelectorAll('button')||[])].some(btn=>
              (btn.textContent||'').includes('补齐旧事件的稳定 ID'));
        })()""")))
        check("p2_sequence_migration_entry_visible",bool(page.js("""(() => {
            const root=document.querySelector('[data-node-id="board"]');
            return [...(root?.querySelectorAll('summary')||[])].some(sum=>
              (sum.textContent||'').includes('场次拆分／合并后的镜头引用迁移'));
        })()""")))

        check("real_generate_candidate_click",node_button(page,"board","生成分镜候选"))
        runpath=f"/api/v1/projects/{pid}/drama-pipeline/runs?nodeId=board"
        def runs():
            return page.js("""(async()=>{const r=await fetch('%s');return await r.json()})()"""%runpath)
        ready=wait_for(lambda:next((r for r in runs() if r.get("status")=="ready"),None),"candidate ready",35)
        check("browser_model_mock_produced_ready_candidate",ready["episodeId"]=="ep-two")
        def candidate_diff_visible():
            return bool(page.js("""(() => {
              const root=document.querySelector('[data-node-id="board"]');
              const detail=[...(root?.querySelectorAll('details')||[])].find(d=>
                (d.querySelector(':scope > summary')?.textContent||'').includes('ready'));
              if(!detail)return false;
              if(!detail.open){detail.open=true;detail.dispatchEvent(new Event('toggle',{bubbles:true}));}
              const preview=detail.querySelector('[aria-label="分镜候选差异预览"]');
              return !!preview && (preview.textContent||'').includes('替换') &&
                (preview.textContent||'').includes('浏览器实际触发');
            })()"""))
        check("p22_candidate_diff_visible_in_real_browser",
              bool(wait_for(candidate_diff_visible,"candidate diff panel",25)))
        check("candidate_explicit_adopt_ui",bool(wait_for(lambda:click_run_candidate(page),"adopt candidate button",25)))
        def changed():
            g=graph(page,pid)
            if not g["ok"]:return None
            try:
                rows=json.loads(find_node(g["data"],"board")["metadata"]["dramaDraft"])["shots"]
                return g if any(shot["episodeId"]=="ep-two" and "浏览器实际触发" in shot["description"] for shot in rows) else None
            except Exception:return None
        after=wait_for(changed,"adopted episode two",35)
        check("first_legacy_config_unchanged_after_adoption",find_node(after["data"],"first-config")==original)
        check("manual_config_edges_preserved_after_adoption",
            [e for e in after["data"]["document"]["connections"] if e["toNodeId"]=="first-config"]==original_links)
        check("first_episode_shot_unchanged",
            next(x for x in json.loads(find_node(after["data"],"board")["metadata"]["dramaDraft"])["shots"] if x["episodeId"]=="ep-one")["description"]=="第一集，主角在家")
        if not node_button(page,"board","确认阶段"):
            raise AssertionError("no visible confirmation button")
        def published():
            g=graph(page,pid)
            if not g["ok"]:return None
            board=find_node(g["data"],"board")
            return g if "浏览器实际触发" in (board["metadata"].get("dramaConfirmed") or "") else None
        confirmed=wait_for(published,"confirmed candidate",35)
        check("confirmation_published_second_episode",True)
        check("first_config_unchanged_after_confirmation",find_node(confirmed["data"],"first-config")==original)
        check("p3_video_production_tab_available",bool(page.js("""(() => {
          const board=document.querySelector('[data-node-id="board"]');
          const toggle=[...(board?.querySelectorAll('button')||[])].find(
            b=>(b.textContent||'').trim()==='视频配置');
          if(!toggle)return false;
          toggle.click();
          return true;
        })()""")))
        check("p3_input_preflight_panel_visible",bool(wait_for(lambda:page.js("""(() => {
          const board=document.querySelector('[data-node-id="board"]');
          const panel=board?.querySelector('[aria-label="逐镜媒体输入预检"]');
          return !!panel&&(panel.textContent||'').includes('实际提交 Prompt') &&
                 (panel.textContent||'').includes('确认分镜与绑定素材');
        })()"""),"P3 media preflight UI",25)))
        check("p3_configured_shot_group_entry_visible",bool(page.js("""(() => {
          const board=document.querySelector('[data-node-id="board"]');
          return [...(board?.querySelectorAll('summary')||[])].some(
            s=>(s.textContent||'').includes('从已配置镜头组建批量生成'));
        })()""")))
        check("p3_unsupported_video_modes_disabled",bool(wait_for(lambda:page.js("""(() => {
          const board=document.querySelector('[data-node-id="board"]');
          const select=[...(board?.querySelectorAll('select')||[])].find(
            s=>(s.parentElement?.textContent||'').includes('视频输入模式'));
          return !!select?.querySelector('option[value="first_last_frame"]')?.disabled;
        })()"""),"P3 disabled unsupported mode",25)))

        # Authenticated ZIP HTTP roundtrip with genuine browser session and CSRF.
        archived=page.js("""(async()=>{
          const csrf=(await (await fetch('/api/v1/session')).json()).csrfToken;
          const archive=await fetch('/api/v1/projects/%s/archive');
          if(!archive.ok)return {stage:'export',status:archive.status};
          const data=await archive.arrayBuffer();
          const imported=await fetch('/api/v1/projects/import-archive',{
            method:'POST',credentials:'same-origin',
            headers:{'content-type':'application/zip','x-atelier-csrf':csrf},body:data
          });
          return {stage:'import',bytes:data.byteLength,status:imported.status,
              record:await imported.json()};
        })()"""%pid)
        check("archive_export_has_zip_bytes",archived.get("bytes",0)>100)
        check("authenticated_archive_import_succeeded",archived.get("status")==201)
        restored=archived["record"]["id"]
        copied=graph(page,restored)
        check("zip_restores_first_config",find_node(copied["data"],"first-config")==original)
        check("zip_restores_second_episode_revision",
              "浏览器实际触发" in find_node(copied["data"],"board")["metadata"]["dramaConfirmed"])
        def persisted_p33d_values(result):
            try:
                assets=json.loads(find_node(result,"assets")["metadata"]["dramaDraft"])["assets"]
                episodes=json.loads(find_node(result,"episodes")["metadata"]["dramaDraft"])["episodes"]
                return assets[0]["description"]=="浏览器局部修改资产描述" and episodes[0]["synopsis"]=="浏览器局部修改第一集概要"
            except (ValueError,KeyError,TypeError):return False
        check("p33d_zip_preserves_both_local_drafts",persisted_p33d_values(copied["data"]))

        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","browser refresh",25)
        check("browser_refresh_did_not_delete_config",find_node(graph(page,pid)["data"],"first-config")==original)
        check("p33d_browser_reload_keeps_local_CAS_edits",persisted_p33d_values(graph(page,pid)["data"]))


        # P3: two real Video Configs (one per episode) -> choose range -> Shot Group.
        # Run only after archive + legacy Config regression checks: grouping may add groupId metadata.
        wait_for(lambda:node_button(page,"board","打开创作内容"),"reopen board after refresh",35)
        wait_for(lambda:bool(page.js("""(() => {
            const root=document.querySelector('[data-node-id="board"]');
            return [...(root?.querySelectorAll('button')||[])].some(b=>(b.textContent||'').trim()==='视频配置');
        })()""")),"P3 board video tab",25)
        check("p3_video_tab_reopened_after_reload",bool(wait_for(lambda:node_button(page,"board","视频配置"),
            "P3 video configuration tab after reload",25)))
        def open_p3_batch_selector():
            return bool(page.js("""(() => {
              const root=document.querySelector('[data-node-id="board"]');
              const detail=root?.querySelector('details[aria-label="P3 选镜头组建批量生成"]');
              if(!detail)return false;
              if(!detail.open){detail.open=true;detail.dispatchEvent(new Event('toggle',{bubbles:true}));}
              return detail.querySelectorAll('input[type="checkbox"]').length>=2;
            })()"""))
        check("p3_two_episode_batch_selector_visible",bool(wait_for(open_p3_batch_selector,"P3 batch config options",25)))
        check("p3_explicit_two_config_selection",bool(page.js("""(() => {
          const root=document.querySelector('[data-node-id="board"]');
          const detail=root?.querySelector('details[aria-label="P3 选镜头组建批量生成"]');
          const checks=[...(detail?.querySelectorAll('input[type="checkbox"]')||[])];
          if(checks.length!==2)return false;
          checks.forEach(input=>{if(!input.checked)input.click();});
          return checks.every(input=>input.checked);
        })()""")))
        def create_p3_batch():
            return bool(page.js("""(() => {
              const root=document.querySelector('[data-node-id="board"]');
              const detail=root?.querySelector('details[aria-label="P3 选镜头组建批量生成"]');
              const button=[...(detail?.querySelectorAll('button')||[])].find(btn=>
                (btn.textContent||'').includes('组建所选镜头并进入批量预检'));
              if(!button||button.disabled)return false;
              button.click();return true;
            })()"""))
        check("p3_explicit_create_group_click",bool(wait_for(create_p3_batch,"P3 create shot group",25)))
        def grouped_p3():
            g=graph(page,pid)
            if not g["ok"]:return None
            for n in g["data"]["document"]["nodes"]:
                if n["type"]=="group" and n.get("metadata",{}).get("shotGroup",{}).get("shots"):
                    return g,n
            return None
        p3_group=wait_for(grouped_p3,"persisted P3 shot group",25)
        group_shots=p3_group[1]["metadata"]["shotGroup"]["shots"]
        check("p3_shotgroup_selected_config_ids",
              [x["generationNodeId"] for x in group_shots]==["first-config","second-config"])
        check("p3_shotgroup_independent_by_default",all(x["mode"]=="independent" for x in group_shots))
        check("p3_shotgroup_does_not_automatically_submit_media",not any(
            "/api/v1/jobs" in item["path"] and item["method"]=="POST"
            for item in page.network_requests))
        check("no_real_model_or_media_requests",not any(
             "/api/v1/jobs" in item["path"] and item["method"]=="POST"
             for item in page.network_requests))
        report["result"]="pass"
        report["archiveBytes"]=archived["bytes"]
        print("P1_REAL_CHROME_BROWSER_PASS "+json.dumps(report,ensure_ascii=False),flush=True)
    except BaseException as err:
        report["result"]="failed"
        report["error"]=str(err)[:500]
        if page:
            try:
                report["nodePanelTexts"]=page.js("""[...document.querySelectorAll('[data-node-id]')].map(
                  n=>({id:n.dataset.nodeId,buttons:[...n.querySelectorAll('button')].map(b=>b.textContent?.trim()).filter(Boolean).slice(0,15),
                   selectors:[...n.querySelectorAll('select')].map(s=>({label:s.getAttribute('aria-label'),value:s.value}))})).slice(0,10)""")
            except Exception:pass
            try:report["bodyTail"]=page.text()[-1200:]
            except Exception:pass
        print("P1_REAL_CHROME_BROWSER_FAIL "+json.dumps(report,ensure_ascii=False),flush=True)
        raise
    finally:
        try:
            if page:page.close()
        except Exception:pass
        for process in (chrome,vite,backend):
            try:kill_tree(process)
            except Exception:pass
        for log in logs:log.close()
        if os.environ.get("ATELIER_KEEP_P1_BROWSER_FIXTURE")!="1":
            import shutil
            shutil.rmtree(root,ignore_errors=True)
            shutil.rmtree(chrome_profile,ignore_errors=True)
if __name__=="__main__":main()
