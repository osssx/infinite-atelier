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
      const node=document.querySelector('[data-node-id=%s]');const portal=document.querySelector('[data-creative-workspace-node-id]');const root=portal?.getAttribute('data-creative-workspace-node-id')===node?.dataset.nodeId?portal:node;
      const target=[...(root?.querySelectorAll('button')||[])].find(b=>(b.innerText||b.textContent||'').trim()===%s);
      if(!target||target.disabled)return false;
      target.click();return true;
    })()"""%(json.dumps(node_id),json.dumps(label,ensure_ascii=False))))
def choose_episode(page):
    return bool(jseval(page,"""(() => {
      const root=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
      const select=root?.querySelector('select[aria-label="生成范围：剧集"]');
      if(!select)return false;
      const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      setter.call(select,'ep-two');
      select.dispatchEvent(new Event('change',{bubbles:true}));
      return select.value==='ep-two';
    })()"""))
def quick_card_select(page,node_id,aria,value):
    return bool(page.js("""(() => {
      const root=document.querySelector('[data-node-id=%s]');
      const select=[...(root?.querySelectorAll('select')||[])].find(s=>s.getAttribute('aria-label')===%s);
      if(!select)return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,%s);
      select.dispatchEvent(new Event('change',{bubbles:true}));
      return select.value===%s;
    })()"""%(json.dumps(node_id),json.dumps(aria,ensure_ascii=False),
           json.dumps(value,ensure_ascii=False),json.dumps(value,ensure_ascii=False))))
def quick_card_input(page,node_id,aria,value):
    return bool(page.js("""(() => {
      const root=document.querySelector('[data-node-id=%s]');
      const input=[...(root?.querySelectorAll('input,textarea')||[])].find(el=>el.getAttribute('aria-label')===%s);
      if(!input)return false;
      const proto=input.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(input,%s);
      input.dispatchEvent(new Event('input',{bubbles:true}));
      return input.value===%s;
    })()"""%(json.dumps(node_id),json.dumps(aria,ensure_ascii=False),
           json.dumps(value,ensure_ascii=False),json.dumps(value,ensure_ascii=False))))
def graph(page,pid):
    return jseval(page,"""(async()=>{
      const res=await fetch('/api/v1/projects/%s',{credentials:'same-origin'});
      return {ok:res.ok,data:await res.json()};
    })()"""%pid)
def find_node(g,node_id):
    return next(n for n in g["document"]["nodes"] if n["id"]==node_id)
def click_run_candidate(page):
    return bool(jseval(page,"""(() => {
      const board=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
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
            if stage=="episodes":
                check("p34b2_episodes_summary_visible",bool(wait_for(lambda:page.js("""
                    !!document.querySelector('[data-node-id="episodes"] [aria-label="剧集规划摘要"]')
                """),"lightweight episodes summary",25)))
                check("p34b2_episodes_count_without_editor",bool(wait_for(lambda:page.js("""
                    (document.querySelector('[data-node-id="episodes"] [aria-label="剧集规划摘要"]')?.textContent||'').includes('已规划 2 集')
                """),"episodes summary count",25)))
                check("p34b2_episodes_editor_not_mounted",bool(page.js("""
                    (()=>{const el=document.querySelector('[data-node-id="episodes"]');
                    return !el?.querySelector('textarea') && !el?.textContent?.includes('剧情事件')})()
                """)))
                continue
            def open_scope():
                return bool(page.js("""(() => {
                  const node=document.querySelector('[data-node-id=%s]');const portal=document.querySelector('[data-creative-workspace-node-id]');const root=portal?.getAttribute('data-creative-workspace-node-id')===node?.dataset.nodeId?portal:node;
                  const button=root?.querySelector('[aria-label=%s] button[aria-expanded]');
                  if(!button)return false;
                  if(button.getAttribute('aria-expanded')==='false')button.click();
                  return true;
                })()"""%(json.dumps(stage),json.dumps(label+"独立存储分页浏览",ensure_ascii=False))))
            check("p33_lazy_"+stage+"_browse_click",bool(wait_for(open_scope,"P3.3 open scope "+stage,25)))
            def scope_loaded():
                return bool(page.js("""(() => {
                   const node=document.querySelector('[data-node-id=%s]');const portal=document.querySelector('[data-creative-workspace-node-id]');const root=portal?.getAttribute('data-creative-workspace-node-id')===node?.dataset.nodeId?portal:node;
                   const browser=root?.querySelector('[aria-label=%s]');
                   return !!browser&&(browser.textContent||'').includes(%s);
                })()"""%(json.dumps(stage),json.dumps(label+"独立存储分页浏览",ensure_ascii=False),
                        json.dumps(label+"共 "+str(count)+" 项",ensure_ascii=False))))
            check("p33_lazy_"+stage+"_shows_count_without_editor",bool(wait_for(scope_loaded,"P3.3 count "+stage,25)))
            check("p33_lazy_"+stage+"_editor_still_unloaded",bool(page.js("""(() => {
                const node=document.querySelector('[data-node-id=%s]');const portal=document.querySelector('[data-creative-workspace-node-id]');const root=portal?.getAttribute('data-creative-workspace-node-id')===node?.dataset.nodeId?portal:node;
                return [...(root?.querySelectorAll('button')||[])].some(
                  btn=>(btn.textContent||'').trim()==='打开创作内容');
            })()"""%json.dumps(stage))))

        check("p34b2_storyboard_summary_without_full_editor",bool(wait_for(lambda:page.js("""
            (()=>{const el=document.querySelector('[data-node-id="board"] [aria-label="分镜配置摘要"]');
             return !!el&&(el.textContent||'').includes('2 镜头')&&
               !el.querySelector('textarea')&&
               !document.querySelector('[data-creative-workspace-node-id]');
            })()
        """),"lightweight storyboard summary",25)))

        # P3.3d: perform real controlled-input edits in the compact node
        # browser, not by calling the API directly. Afterwards the canvas
        # state must rehydrate the updated authoritative payload.
        for stage,label,field,updated in (
            ("assets","资产","描述","浏览器局部修改资产描述"),
            ("episodes","剧集","剧情概要","浏览器局部修改第一集概要")
        ):
            if stage=="episodes":
                check("p34b2_episode_full_editor_open",bool(wait_for(
                    lambda:node_button(page,"episodes","打开完整编辑器 ↗"),
                    "episode maximize action",35)))
                check("episode_workspace_theme_and_navigation",bool(wait_for(lambda:page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    if(!root)return false;
                    const fg=root.dataset.dramaWorkspaceTheme==='dark'?'rgb(245, 245, 244)':'rgb(41, 37, 36)';
                    const tabs=root.querySelector('nav[aria-label="创作工作区功能"]');
                    return ['dark','light'].includes(root.dataset.dramaWorkspaceTheme)&&
                       getComputedStyle(root).color===fg&&
                      tabs?.querySelector('button[aria-pressed="true"]')?.textContent?.trim()==='剧集编辑'&&
                      tabs.scrollWidth>0;
                })()"""),"maximized episode theme and tabs",35)))
                check("episode_tabs_descriptions_only_on_tooltips",bool(page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    const nav=root?.querySelector('nav[aria-label="创作工作区功能"]');
                    if(!nav||nav.nextElementSibling!==root.querySelector('[data-drama-workspace-content]'))return false;
                    const pairs=[
                     ['剧集编辑','按集编辑剧情、事件、场次及来源引用'],
                     ['分页与单条 CAS','按页读取、精准保存和批量提交草案'],
                     ['生成候选','按运行状态浏览候选，展开查看内容与采用选项'],
                     ['影响与历史','版本快照与上游影响直接在工作区内查看']
                    ];
                    const buttons=[...nav.querySelectorAll('button')];
                    return buttons.length===pairs.length&&pairs.every(([label,tip],i)=>
                      buttons[i].textContent.trim()===label&&buttons[i].getAttribute('aria-description')===tip)&&
                      ![...root.querySelectorAll('p')].some(p=>pairs.some(([,tip])=>p.textContent.trim()===tip));
                })()""")))
                check("episode_tab_tooltip_hover_trigger",bool(page.js("""(() => {
                    const nav=document.querySelector('[data-creative-workspace-node-id="episodes"] nav');
                    const btn=[...(nav?.querySelectorAll('button')||[])].find(b=>b.textContent.trim()==='影响与历史');
                    if(!btn)return false;
                    btn.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
                    return true;
                })()""")))
                check("episode_tab_tooltip_visible_on_hover",bool(wait_for(lambda:page.js("""(() => {
                    const tip=document.querySelector('[data-drama-tab-tooltip="history"][role="tooltip"]');
                    return !!tip&&tip.getBoundingClientRect().width>0&&
                      tip.textContent?.trim()==='版本快照与上游影响直接在工作区内查看'&&
                      document.querySelector('[data-creative-workspace-node-id="episodes"] nav button[aria-pressed="true"]')?.textContent?.trim()==='剧集编辑';
                })()"""),"portal tooltip visible on React hover",18)))
                page.js("""(() => {
                    const btn=[...document.querySelectorAll('[data-creative-workspace-node-id="episodes"] nav button')].find(b=>b.textContent.trim()==='影响与历史');
                    btn?.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));
                })()""")
                check("episode_workspace_split_editor",bool(wait_for(lambda:page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    const layout=root?.querySelector('[data-episode-editor-layout="expanded"]');
                    const nav=layout?.querySelector('[aria-label="剧集导航"]');
                    const field=layout?.querySelector('[aria-label="当前剧集编辑区"]');
                    const target=root?.querySelector('[aria-label="剧集规划目标集数"]');
                    const actions=root?.querySelector('[aria-label="剧集生成与确认操作"]');
                    const rect=root?.getBoundingClientRect(),r=actions?.getBoundingClientRect();
                    return !!layout&&!!nav&&!!field&&!!target&&!!actions&&
                       nav.querySelectorAll('button').length>=2&&
                       field.querySelectorAll('textarea').length>=3&&
                       !!r&&!!rect&&r.width>0&&r.bottom<=rect.bottom+4&&
                       !!field.querySelector('section[aria-label="场次规划"]');
                })()"""),"maximized episode split editor and action footer",35)))
                check("episode_original_sources_editor_hidden",bool(page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    return !!root&&!root.textContent?.includes('原文出处')&&
                     !root.querySelector('[aria-label="剧集原文段落 ID"]');
                })()""")))
                check("episode_history_tab_open",bool(wait_for(
                    lambda:node_button(page,"episodes","影响与历史"),"episode history tab",25)))
                check("episode_history_direct_inline_panel",bool(wait_for(lambda:page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    const inline=root?.querySelector('[data-canvas-text-versions-inline]');
                    const impact=root?.querySelector('[aria-label="上游影响检查"]');
                    const versions=inline?.querySelector('[aria-label]');
                    return !!inline&&!!impact&&!!versions&&
                     !!inline.closest('[data-drama-history-layout]')&&
                     !root.querySelector('button[aria-label="历史版本"]');
                })()"""),"inline text versions and impact panel",40)))
                check("episode_history_initial_version_selected",bool(wait_for(lambda:page.js("""(() => {
                    const inline=document.querySelector('[data-canvas-text-versions-inline]');
                    const chosen=inline?.querySelector('button[aria-current="true"]');
                    const preview=inline?.querySelector('article');
                    return !!chosen&&!!preview&&(preview.textContent||'').includes('第一集');
                })()"""),"version list and historical episode preview",35)))
                check("episode_history_fills_available_workspace_height",bool(wait_for(lambda:page.js("""(() => {
                    const workspace=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    const content=workspace?.querySelector('[data-drama-workspace-content]');
                    const layout=content?.querySelector('[data-drama-history-layout]');
                    const fill=layout?.querySelector('[data-drama-history-fill]');
                    const inline=fill?.querySelector('[data-canvas-text-versions-inline]');
                    const body=inline?.querySelector('[data-canvas-shortcuts-ignore]');
                    const grid=body?.querySelector('.grid');
                    const panes=grid?.querySelectorAll(':scope > section');
                    if(!content||!layout||!fill||!inline||!body||!grid||!panes||panes.length!==2)return false;
                    const a=content.getBoundingClientRect(),b=layout.getBoundingClientRect(),
                      f=fill.getBoundingClientRect(),i=inline.getBoundingClientRect(),
                      v=body.getBoundingClientRect(),g=grid.getBoundingClientRect();
                    const close=(x,y)=>Math.abs(x-y)<=5;
                    return b.height>360&&i.height>330&&g.height>160&&
                       close(f.height,i.height)&&close(i.height,v.height)&&
                       close(a.bottom-16,b.bottom)&&close(f.bottom,i.bottom)&&
                       close(v.bottom,i.bottom)&&close(g.bottom,v.bottom)&&
                       getComputedStyle(panes[0]).overflow==='hidden'&&
                       getComputedStyle(panes[1]).overflow==='hidden';
                })()"""),"inline historical versions stretch to full workspace height",35)))
                check("episode_history_impact_left_versions_right",bool(wait_for(lambda:page.js("""(() => {
                    const layout=document.querySelector('[data-drama-history-layout]');
                    const sections=[...(layout?.querySelectorAll(':scope > section')||[])];
                    if(sections.length!==2)return false;
                    const [impact,versions]=sections;
                    const left=impact.getBoundingClientRect(),right=versions.getBoundingClientRect();
                    const wide=window.innerWidth>=1280;
                    return impact.getAttribute('aria-label')==='上游影响面板'&&
                      versions.getAttribute('aria-label')==='历史版本面板'&&
                      (wide?left.width>=220&&left.width<=270&&
                        left.left<right.left&&left.right<=right.left+3&&
                        Math.abs(left.top-right.top)<=5:
                        left.top<right.top&&left.bottom<=right.top+3);
                })()"""),"upstream impact appears before versions in responsive workspace",30)))
                check("episode_history_impact_scrollbar_only_on_overflow",bool(wait_for(lambda:page.js("""(() => {
                    const impact=document.querySelector('[data-drama-impact-scroll]');
                    if(!impact)return false;
                    const panel=impact.querySelector('[aria-label="上游影响检查"]');
                    const loaded=(panel?.textContent||'').includes('当前确认结果与上游一致');
                    if(!loaded||panel.querySelector('[aria-label="细粒度影响预览"]'))return false;
                    const styles=getComputedStyle(impact);
                    if(styles.overflowY!=='auto'||styles.scrollbarGutter!=='auto')return false;
                    // The real empty-impact report must not scroll, not just a synthetic hidden case.
                    const naturallyFits=impact.scrollHeight<=impact.clientHeight+2&&
                        impact.getBoundingClientRect().height<impact.parentElement.clientHeight-12;
                    if(!naturallyFits)return false;
                    const original=[...impact.children];
                    const display=original.map(child=>child.style.display);
                    try{
                        // Simulate a short impact report: no overflow or reserved scrollbar gutter.
                        original.forEach(child=>{child.style.display='none'});
                        impact.scrollTop=0;
                        const shortFits=impact.scrollHeight<=impact.clientHeight+2&&
                          impact.getBoundingClientRect().height<impact.parentElement.clientHeight-20;
                        const filler=document.createElement('div');
                        filler.style.height=String(impact.parentElement.clientHeight+200)+'px';
                        impact.appendChild(filler);
                        // Simulate a long impact report: scrollbar appears and scrollTop changes.
                        const nowOverflows=impact.scrollHeight>impact.clientHeight+100;
                        impact.scrollTop=100;
                        const canScroll=impact.scrollTop>0;
                        filler.remove();
                        return shortFits&&nowOverflows&&canScroll&&
                           impact.scrollHeight<=impact.clientHeight+2;
                    } finally {
                        original.forEach((child,index)=>{child.style.display=display[index]});
                        impact.scrollTop=0;
                    }
                })()"""),"overflow-y-auto hides unnecessary scrollbar and scrolls long impact",30)))
                check("episode_history_has_no_second_dialog",bool(page.js("""(() => {
                    const inline=document.querySelector('[data-canvas-text-versions-inline]');
                    const parent=inline?.closest('.ant-modal');
                    return !!parent&&[...document.querySelectorAll('.ant-modal')].filter(el=>
                       getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().width>0).every(el=>el===parent);
                })()""")))
                check("episode_history_scoped_version_api",bool(wait_for(lambda:any(
                    "/nodes/episodes/text-versions" in req.get("path","") and req.get("method")=="GET"
                    for req in page.network_requests),"scoped version list request",25)))
                check("episode_history_impact_auto_loaded",bool(wait_for(lambda:page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    const section=root?.querySelector('[aria-label="上游影响检查"]');
                    if(!section)return false;
                    const text=section.textContent||'';
                    return text.includes('当前确认结果与上游一致')||
                      text.includes('上游已有更新')||text.includes('此版本缺少历史依赖');
                })()"""),"inline upstream impact read",25)))
                check("episode_runs_tab_open",bool(wait_for(
                    lambda:node_button(page,"episodes","生成候选"),"episode run candidates tab",25)))
                check("episode_runs_summary_theme",bool(wait_for(lambda:page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    const runs=root?.querySelector('[data-drama-runs-panel]');
                    if(!runs)return false;
                    const computed=getComputedStyle(runs);
                    const expected=root.dataset.dramaWorkspaceTheme==='dark'?'rgb(31, 29, 26)':'rgb(251, 250, 247)';
                    return computed.backgroundColor===expected&&
                       (runs.textContent||'').includes('生成候选记录')&&
                       (runs.textContent||'').includes('待采用');
                })()"""),"runs summary card themed",25)))
                check("episode_history_unmounted_on_exit",bool(page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    return !!root&&!root.querySelector('[data-canvas-text-versions-inline]')&&
                       !root.querySelector('[data-drama-history-layout]');
                })()""")))
                check("p34b3_episodes_scoped_tab",bool(wait_for(
                    lambda:node_button(page,"episodes","分页与单条 CAS"),"episodes scoped tab",25)))
                wait_for(lambda:page.js("""
                   !!document.querySelector('[data-creative-workspace-node-id="episodes"] [aria-label="剧集独立存储分页浏览"]')
                """),"episode scoped editor mounted",35)
                wait_for(lambda:page.js("""(() => {
                    const button=document.querySelector('[data-creative-workspace-node-id="episodes"] [aria-label="剧集独立存储分页浏览"] button[aria-expanded]');
                    if(!button)return false;
                    if(button.getAttribute('aria-expanded')==='false')button.click();
                    return true;
                })()"""),"open scoped episode browser within workspace",25)
            def open_draft():
                return bool(page.js("""(() => {
                    const node=document.querySelector('[data-node-id=%s]');const portal=document.querySelector('[data-creative-workspace-node-id]');const root=portal?.getAttribute('data-creative-workspace-node-id')===node?.dataset.nodeId?portal:node;
                    const browser=root?.querySelector('[aria-label=%s]');
                    const checkbox=browser?.querySelector('input[type="checkbox"]');
                    if(!checkbox)return false;
                    if(!checkbox.checked)checkbox.click();
                    return checkbox.checked;
                })()"""%(json.dumps(stage),json.dumps(label+"独立存储分页浏览",ensure_ascii=False))))
            check("p33d_"+stage+"_draft_toggle",bool(wait_for(open_draft,"P3.3d draft "+stage,25)))
            def editor_open():
                return bool(page.js("""(() => {
                    const node=document.querySelector('[data-node-id=%s]');const portal=document.querySelector('[data-creative-workspace-node-id]');const root=portal?.getAttribute('data-creative-workspace-node-id')===node?.dataset.nodeId?portal:node;
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
                const node=document.querySelector('[data-node-id=%s]');const portal=document.querySelector('[data-creative-workspace-node-id]');const root=portal?.getAttribute('data-creative-workspace-node-id')===node?.dataset.nodeId?portal:node;
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
            if stage=="episodes":
                check("p34b3_scope_unmounts_full_fields",bool(page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    return !!root&&!root.textContent?.includes('剧情事件（每行一条）');
                })()""")))
                check("p34b3_unsaved_form_detected",bool(wait_for(lambda:page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    return (root?.textContent||'').includes('尚未保存的局部草案修改');
                })()"""),"P3.4b3 local dirty guard",25)))
                check("p34b3_tab_switch_prompts",bool(page.js("""(() => {
                    const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
                    const button=[...(root?.querySelectorAll('nav button')||[])].find(
                        b=>(b.textContent||'').trim()==='生成候选');
                    if(!button)return false;
                    button.click();return true;
                })()""")))
                check("p34b3_pending_confirmation",bool(wait_for(lambda:page.js("""(() => {
                    return [...document.querySelectorAll('.ant-modal')].some(
                        node=>(node.textContent||'').includes('存在未提交的草案修改'));
                })()"""),"P3.4b3 unsaved confirmation",25)))
                check("p34b3_continue_preserves_editor",bool(page.js("""(() => {
                    const button=[...document.querySelectorAll('.ant-modal button')].find(
                        b=>(b.textContent||'').trim()==='继续编辑');
                    if(!button)return false;
                    button.click();return true;
                })()""")))
            def click_draft_save():
                return bool(page.js("""(() => {
                    const node=document.querySelector('[data-node-id=%s]');const portal=document.querySelector('[data-creative-workspace-node-id]');const root=portal?.getAttribute('data-creative-workspace-node-id')===node?.dataset.nodeId?portal:node;
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
        # P3.3e: stage two different assets through the real React input
        # controls, then commit them as ONE scoped transaction and revision.
        # Single-entry save hydrates its full creative node, replacing the
        # compact-only scope browser. Reload to exercise batch edits via the
        # real cold-start/pointer-only browser rather than relying on stale UI.
        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","P3.3e reload compact canvas",35)
        def open_batch_scope():
            return bool(page.js("""(() => {
                const node=document.querySelector('[data-node-id="assets"]');
                const browser=node?.querySelector('[aria-label="资产独立存储分页浏览"]');
                const button=browser?.querySelector('button[aria-expanded]');
                if(!button)return false;
                if(button.getAttribute('aria-expanded')==='false')button.click();
                const checkbox=browser.querySelector('input[type="checkbox"]');
                if(!checkbox)return false;
                if(!checkbox.checked)checkbox.click();
                return checkbox.checked;
            })()"""))
        check("p33e_batch_scope_reopened",bool(wait_for(open_batch_scope,"P3.3e scope after reload",35)))
        check("p33e_batch_scope_loaded",bool(wait_for(lambda:page.js("""(() => {
            const b=document.querySelector('[data-node-id="assets"] [aria-label="资产独立存储分页浏览"]');
            return !!b&&(b.textContent||'').includes('资产共 2 项')&&
                !!b.querySelector('input[type="checkbox"]:checked');
        })()"""),"P3.3e draft page",35)))
        prior_batch_revision=graph(page,pid)["data"]["revision"]
        for index,field,new_value in (
            (0,"名称","浏览器批量改名的主角"),
            (1,"描述","浏览器批量修改家的描述")
        ):
            def stage_entry():
                return bool(page.js("""(() => {
                    const browser=document.querySelector('[data-node-id="assets"] [aria-label="资产独立存储分页浏览"]');
                    const entry=browser?.querySelectorAll(':scope > details')[%s];
                    if(!entry)return false;
                    entry.open=true;
                    const editor=entry.querySelector('details[aria-label="编辑当前资产或剧集条目"]');
                    if(!editor)return false;
                    editor.open=true;
                    const label=[...(editor.querySelectorAll('label')||[])].find(l=>
                        (l.textContent||'').includes(%s));
                    const input=label?.querySelector('input,textarea');
                    if(!input)return false;
                    const proto=input.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;
                    Object.getOwnPropertyDescriptor(proto,'value').set.call(input,%s);
                    input.dispatchEvent(new Event('input',{bubbles:true}));
                    return true;
                })()"""%(index,json.dumps(field,ensure_ascii=False),json.dumps(new_value,ensure_ascii=False))))
            check("p33e_batch_input_"+str(index),bool(wait_for(stage_entry,"P3.3e asset input "+str(index),25)))
            def stage_button():
                return bool(page.js("""(() => {
                    const browser=document.querySelector('[data-node-id="assets"] [aria-label="资产独立存储分页浏览"]');
                    const entry=browser?.querySelectorAll(':scope > details')[%s];
                    const editor=entry?.querySelector('details[aria-label="编辑当前资产或剧集条目"]');
                    const button=[...(editor?.querySelectorAll('button')||[])].find(b=>
                        (b.textContent||'').includes('加入批量修改'));
                    if(!button||button.disabled)return false;
                    button.click();
                    return true;
                })()"""%index))
            check("p33e_batch_staged_"+str(index),bool(wait_for(stage_button,"P3.3e stage "+str(index),25)))
        check("p33e_batch_two_pending",bool(page.js("""(() => {
            const browser=document.querySelector('[data-node-id="assets"] [aria-label="资产独立存储分页浏览"]');
            return (browser?.textContent||'').includes('已暂存 2 项');
        })()""")))
        check("p33e_batch_click",bool(page.js("""(() => {
            const browser=document.querySelector('[data-node-id="assets"] [aria-label="资产独立存储分页浏览"]');
            const button=[...(browser?.querySelectorAll('button')||[])].find(b=>
                (b.textContent||'').includes('提交全部暂存修改'));
            if(!button||button.disabled)return false;
            button.click();
            return true;
        })()""")))
        def batch_persisted():
            g=graph(page,pid)
            if not g.get("ok"):return None
            try:
                row=json.loads(find_node(g["data"],"assets")["metadata"]["dramaDraft"])["assets"]
                if row[0]["name"]=="浏览器批量改名的主角" and row[1]["description"]=="浏览器批量修改家的描述":
                    return g
            except (ValueError,KeyError,TypeError):pass
            return None
        successful_batch=wait_for(batch_persisted,"P3.3e batch authoritative save",35)
        check("p33e_batch_saved_together",bool(successful_batch))
        check("p33e_batch_one_revision",successful_batch["data"]["revision"]==prior_batch_revision+1)
        check("p33e_batch_cleared",bool(wait_for(lambda:page.js("""(() => {
            const browser=document.querySelector('[data-node-id="assets"] [aria-label="资产独立存储分页浏览"]');
            return (browser?.textContent||'').includes('已暂存 0 项');
        })()"""),"P3.3e clear staged edits",25)))
        # Full creative editors now live outside the canvas; verify the new
        # page-level workspace instead of treating an inline node as an editor.
        if node_button(page,"assets","打开创作内容"):
            wait_for(lambda:page.js(
                "(document.querySelector('[data-node-id=\"assets\"]')?.textContent||'').includes('确认阶段')"),
                "load assets content",25)
        check("story_and_episode_nodes_visible",bool(page.js(
              "!!document.querySelector('[data-node-id=\"episodes\"]')&&!!document.querySelector('[data-node-id=\"story\"]')")))
        check("p34b2_episode_full_editor_reopen",bool(wait_for(
            lambda:node_button(page,"episodes","打开完整编辑器 ↗"),"reopen episodes workspace",35)))
        wait_for(lambda:page.js(
            "!!document.querySelector('[data-creative-workspace-node-id=\"episodes\"]')"),
            "episodes workspace mounted",30)
        check("p2_event_identity_edit_action_visible",bool(wait_for(lambda:page.js("""(() => {
            const root=document.querySelector('[data-creative-workspace-node-id="episodes"]');
            return [...(root?.querySelectorAll('button')||[])].some(btn=>
              (btn.textContent||'').includes('补齐旧事件的稳定 ID'));
        })()"""),"episode full editor events",30)))
        page.js("""document.querySelector('.ant-modal-close')?.click();true""")
        wait_for(lambda:page.js("!document.querySelector('[data-creative-workspace-node-id=\"episodes\"]')"),
                 "close episodes workspace",35)
        check("p34b2_storyboard_full_editor_open",bool(wait_for(
            lambda:node_button(page,"board","打开完整编辑器 ↗"),"open storyboard workspace",35)))
        wait_for(lambda:page.js(
            "!!document.querySelector('[data-creative-workspace-node-id=\"board\"]')"),
            "storyboard workspace mounted",30)
        wait_for(lambda:choose_episode(page),"episode selector",25)
        check("episode_two_selected",True)
        check("p2_sequence_migration_entry_visible",bool(page.js("""(() => {
            const root=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
            return [...(root?.querySelectorAll('summary')||[])].some(sum=>
              (sum.textContent||'').includes('场次拆分／合并后的镜头引用迁移'));
        })()""")))

        check("real_generate_candidate_click",node_button(page,"board","生成分镜候选"))
        runpath=f"/api/v1/projects/{pid}/drama-pipeline/runs?nodeId=board"
        def runs():
            return page.js("""(async()=>{const r=await fetch('%s');return await r.json()})()"""%runpath)
        ready=wait_for(lambda:next((r for r in runs() if r.get("status")=="ready"),None),"candidate ready",35)
        check("browser_model_mock_produced_ready_candidate",ready["episodeId"]=="ep-two")
        check("p34b3_runs_tab",bool(wait_for(
            lambda:node_button(page,"board","生成候选"),"open candidate tab",25)))
        def candidate_diff_visible():
            return bool(page.js("""(() => {
              const root=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
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
        check("p34b3_return_shots_tab",bool(wait_for(
            lambda:node_button(page,"board","分镜表"),"return storyboard editor",25)))
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
          const board=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
          const toggle=[...(board?.querySelectorAll('button')||[])].find(
            b=>(b.textContent||'').trim()==='视频配置');
          if(!toggle)return false;
          toggle.click();
          return true;
        })()""")))
        check("p3_input_preflight_panel_visible",bool(wait_for(lambda:page.js("""(() => {
          const board=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
          const panel=board?.querySelector('[aria-label="逐镜媒体输入预检"]');
          return !!panel&&(panel.textContent||'').includes('实际提交 Prompt') &&
                 (panel.textContent||'').includes('确认分镜与绑定素材');
        })()"""),"P3 media preflight UI",25)))
        check("p3_configured_shot_group_entry_visible",bool(page.js("""(() => {
          const board=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
          return [...(board?.querySelectorAll('summary')||[])].some(
            s=>(s.textContent||'').includes('从已配置镜头组建批量生成'));
        })()""")))
        check("p3_unsupported_video_modes_disabled",bool(wait_for(lambda:page.js("""(() => {
          const board=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
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
        check("p33e_zip_preserves_two_asset_edits",bool(
            json.loads(find_node(copied["data"],"assets")["metadata"]["dramaDraft"])["assets"][0]["name"]=="浏览器批量改名的主角" and
            json.loads(find_node(copied["data"],"assets")["metadata"]["dramaDraft"])["assets"][1]["description"]=="浏览器批量修改家的描述"))

        page.call("Page.reload",{"ignoreCache":True})
        wait_for(lambda:page.js("document.readyState")=="complete","browser refresh",25)
        check("browser_refresh_did_not_delete_config",find_node(graph(page,pid)["data"],"first-config")==original)
        check("p33d_browser_reload_keeps_local_CAS_edits",persisted_p33d_values(graph(page,pid)["data"]))
        check("p33e_browser_reload_keeps_batch_edits",bool(batch_persisted()))


        # P3: two real Video Configs (one per episode) -> choose range -> Shot Group.
        # Run only after archive + legacy Config regression checks: grouping may add groupId metadata.
        wait_for(lambda:node_button(page,"board","打开完整编辑器 ↗"),"reopen board after refresh",35)
        wait_for(lambda:bool(page.js("""(() => {
            const root=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
            return [...(root?.querySelectorAll('button')||[])].some(b=>(b.textContent||'').trim()==='视频配置');
        })()""")),"P3 board video tab",25)
        check("p3_video_tab_reopened_after_reload",bool(wait_for(lambda:node_button(page,"board","视频配置"),
            "P3 video configuration tab after reload",25)))
        def open_p3_batch_selector():
            return bool(page.js("""(() => {
              const root=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
              const detail=root?.querySelector('details[aria-label="P3 选镜头组建批量生成"]');
              if(!detail)return false;
              if(!detail.open){detail.open=true;detail.dispatchEvent(new Event('toggle',{bubbles:true}));}
              return detail.querySelectorAll('input[type="checkbox"]').length>=2;
            })()"""))
        check("p3_two_episode_batch_selector_visible",bool(wait_for(open_p3_batch_selector,"P3 batch config options",25)))
        check("p3_explicit_two_config_selection",bool(page.js("""(() => {
          const root=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
          const detail=root?.querySelector('details[aria-label="P3 选镜头组建批量生成"]');
          const checks=[...(detail?.querySelectorAll('input[type="checkbox"]')||[])];
          if(checks.length!==2)return false;
          checks.forEach(input=>{if(!input.checked)input.click();});
          return checks.every(input=>input.checked);
        })()""")))
        def create_p3_batch():
            return bool(page.js("""(() => {
              const root=(document.querySelector('[data-creative-workspace-node-id="board"]')||document.querySelector('[data-node-id="board"]'));
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
        # P3.4b4: true indexed single-entry CAS quick editing from compact cards.
        # All earlier legacy, archive, generation and config assertions have completed.
        wait_for(lambda:page.js("!document.querySelector('[data-creative-workspace-node-id]')"),
                 "P3.4b4 previous modal closed",25)
        before_quick=graph(page,pid)["data"]
        before_ep=find_node(before_quick,"episodes")
        before_board=find_node(before_quick,"board")
        old_episodes=json.loads(before_ep["metadata"]["dramaDraft"])["episodes"]
        old_shots=json.loads(before_board["metadata"]["dramaDraft"])["shots"]
        # Episode summary and edit layout: actual Chrome DOM bounds and active canvas tokens.
        check("episode_card_theme_matches_canvas",bool(wait_for(lambda:page.js("""(() => {
          const card=document.querySelector('[data-node-id="episodes"] [aria-label="剧集规划摘要"]');
          if(!card)return false;
          const color=card.dataset.dramaCardTheme==='dark'?'rgb(245, 245, 244)':'rgb(41, 37, 36)';
          const summary=card.querySelector('div.rounded-xl');
          return ['light','dark'].includes(card.dataset.dramaCardTheme)&&
            getComputedStyle(card).color===color&&!!summary&&
            getComputedStyle(summary).backgroundColor!=='rgba(0, 0, 0, 0)'&&
            !!card.querySelector('nav[aria-label="摘要条目切换"]')&&
            !!card.querySelector('footer');
        })()"""),"episode card theme and hierarchy",25)))
        check("episode_card_actions_fit_node",bool(page.js("""(() => {
          const card=document.querySelector('[data-node-id="episodes"] [aria-label="剧集规划摘要"]');
          const footer=card?.querySelector('footer');
          if(!footer)return false;
          const a=card.getBoundingClientRect(),f=footer.getBoundingClientRect();
          return a.width>=200&&f.top>=a.top&&f.bottom<=a.bottom+3&&f.height>=26;
        })()""")))
        check("p34b4_episode_switch_to_draft",bool(wait_for(
            lambda:quick_card_select(page,"episodes","剧集规划版本","draft"),"episode card draft",25)))
        check("p34b4_quick_episode_open",bool(wait_for(
            lambda:node_button(page,"episodes","快速编辑"),"episode quick edit",25)))
        check("p34b4_episode_two_fields_only",bool(wait_for(lambda:page.js("""(() => {
            const card=document.querySelector('[data-node-id="episodes"] [aria-label="剧集快速编辑"]');
            return !!card&&card.querySelectorAll('textarea').length===1&&
                !!card.querySelector('[aria-label="快速编辑集标题"]')&&
                !card.textContent.includes('剧情事件')&&!card.textContent.includes('确认阶段');
        })()"""),"episode quick fields",25)))
        check("episode_quick_editor_theme_and_fixed_footer",bool(wait_for(lambda:page.js("""(() => {
          const form=document.querySelector('[data-node-id="episodes"] [aria-label="剧集快速编辑"]');
          const input=form?.querySelector('[aria-label="快速编辑集标题"]');
          const area=form?.querySelector('[aria-label="快速编辑剧情概要"]');
          const fields=form?.querySelector('.overflow-y-auto');
          const footer=form?.querySelector('footer');
          if(!form||!input||!area||!footer||!fields)return false;
          const editorBounds=form.getBoundingClientRect(),footBounds=footer.getBoundingClientRect();
          const expected=form.dataset.dramaEditorTheme==='dark'?'rgb(41, 37, 36)':'rgb(231, 229, 223)';
          return getComputedStyle(input).backgroundColor===expected&&
            footBounds.top>=editorBounds.top&&footBounds.bottom<=editorBounds.bottom+3&&
            fields.clientHeight<fields.scrollHeight&&
            !!form.querySelector('[data-canvas-no-zoom]')===false&&
            form.hasAttribute('data-canvas-no-zoom')&&
            footer.querySelectorAll('button').length===2;
        })()"""),"episode quick edit layout and palette",25)))
        check("p34b4_episode_input",quick_card_input(page,"episodes","快速编辑剧情概要",
              "P3.4b4 画布快速编辑的第一集概要"))
        check("p34b4_episode_explicit_save",bool(wait_for(lambda:node_button(page,"episodes","保存草案"),
              "episode indexed save",25)))
        def quick_episode_saved():
            g=graph(page,pid)
            if not g.get("ok"):return None
            try:
                episodes=json.loads(find_node(g["data"],"episodes")["metadata"]["dramaDraft"])["episodes"]
                return g["data"] if episodes[0]["synopsis"]=="P3.4b4 画布快速编辑的第一集概要" else None
            except (ValueError,KeyError,TypeError):return None
        episode_after=wait_for(quick_episode_saved,"P3.4b4 episode indexed commit",35)
        new_episodes=json.loads(find_node(episode_after,"episodes")["metadata"]["dramaDraft"])["episodes"]
        check("p34b4_episode_other_entry_untouched",new_episodes[1]==old_episodes[1])
        check("p34b4_episode_confirmed_immutable",find_node(episode_after,"episodes")["metadata"]["dramaConfirmed"]==
              before_ep["metadata"]["dramaConfirmed"])
        check("p34b4_episode_single_cas_revision",episode_after["revision"]==before_quick["revision"]+1)
        check("p34b4_episode_save_keeps_draft_view",bool(wait_for(lambda:page.js("""(() => {
           const select=document.querySelector('[data-node-id="episodes"] select[aria-label="剧集规划版本"]');
           return select?.value==='draft';
        })()"""),"draft version kept",25)))

        check("p34b4_storyboard_switch_to_draft",bool(wait_for(
            lambda:quick_card_select(page,"board","分镜配置版本","draft"),"board card draft",25)))
        check("p34b4_storyboard_choose_episode",bool(wait_for(
            lambda:quick_card_select(page,"board","摘要选择剧集","ep-two"),"board episode two",25)))
        check("p34b4_quick_shot_open",bool(wait_for(
            lambda:node_button(page,"board","快速编辑"),"shot quick edit",25)))
        check("p34b4_shot_two_fields_only",bool(wait_for(lambda:page.js("""(() => {
           const card=document.querySelector('[data-node-id="board"] [aria-label="镜头快速编辑"]');
           return !!card&&card.querySelectorAll('textarea').length===1&&
               !!card.querySelector('[aria-label="快速编辑镜头时长"]')&&
               !card.textContent.includes('视频配置');
        })()"""),"shot quick fields",25)))
        check("p34b4_shot_description_input",quick_card_input(
            page,"board","快速编辑画面描述","P3.4b4 单镜头画面描述更新"))
        check("p34b4_shot_duration_input",quick_card_input(page,"board","快速编辑镜头时长","8.5"))
        check("p34b4_shot_explicit_save",bool(wait_for(lambda:node_button(page,"board","保存草案"),
              "shot indexed save",25)))
        def quick_shot_saved():
            g=graph(page,pid)
            if not g.get("ok"):return None
            try:
                shots=json.loads(find_node(g["data"],"board")["metadata"]["dramaDraft"])["shots"]
                return g["data"] if any(shot["episodeId"]=="ep-two" and
                    shot["description"]=="P3.4b4 单镜头画面描述更新" and
                    shot.get("durationSec")==8.5 for shot in shots) else None
            except (ValueError,KeyError,TypeError):return None
        shot_after=wait_for(quick_shot_saved,"P3.4b4 single shot indexed commit",35)
        updated_shots=json.loads(find_node(shot_after,"board")["metadata"]["dramaDraft"])["shots"]
        check("p34b4_other_shot_untouched",next(x for x in updated_shots if x["episodeId"]=="ep-one")==
              next(x for x in old_shots if x["episodeId"]=="ep-one"))
        check("p34b4_confirmed_shots_immutable",find_node(shot_after,"board")["metadata"]["dramaConfirmed"]==
              before_board["metadata"]["dramaConfirmed"])
        check("p34b4_media_config_unchanged",find_node(shot_after,"first-config")==
              find_node(before_quick,"first-config") and find_node(shot_after,"second-config")==
              find_node(before_quick,"second-config"))

        # Genuine concurrent patch after a form was opened: stale expectedDigest
        # must be rejected without overwriting newer server content or local input.
        check("p34b4_conflict_editor_open",bool(wait_for(
            lambda:node_button(page,"episodes","快速编辑"),"open stale episode editor",25)))
        check("p34b4_conflict_local_input",quick_card_input(
            page,"episodes","快速编辑剧情概要","这段本地修改尚未提交"))
        external=page.js("""(async()=>{
            const pid=%s;
            const src=await fetch('/api/v1/projects/'+pid+
              '/drama-pipeline/revision-scope?nodeId=episodes&draft=true&entryId=ep-one&limit=1');
            if(!src.ok)return {stage:'read',status:src.status};
            const state=await src.json();
            const digest=state.entryDigests?.[0]?.digest;
            const csrf=(await (await fetch('/api/v1/session')).json()).csrfToken;
            const patch=await fetch('/api/v1/projects/'+pid+'/drama-pipeline/entry-draft',{
              method:'PATCH',credentials:'same-origin',
              headers:{'content-type':'application/json','x-atelier-csrf':csrf},
              body:JSON.stringify({nodeId:'episodes',kind:'episodes',entryId:'ep-one',
                operationId:crypto.randomUUID(),expectedDigest:digest,
                changes:{title:'P3.4b4 并发用户更新的标题'}})
            });
            return {stage:'patch',status:patch.status};
        })()"""%json.dumps(pid))
        check("p34b4_external_cas_succeeded",external.get("status")==200)
        check("p34b4_conflicting_save_clicked",bool(wait_for(
            lambda:node_button(page,"episodes","保存草案"),"stale digest save",25)))
        check("p34b4_conflict_visible_and_keeps_input",bool(wait_for(lambda:page.js("""(() => {
            const root=document.querySelector('[data-node-id="episodes"] [aria-label="剧集快速编辑"]');
            return !!root&&(root.textContent||'').includes('未覆盖任何内容')&&
                root.querySelector('[aria-label="快速编辑剧情概要"]')?.value==='这段本地修改尚未提交';
        })()"""),"quick edit conflict",25)))
        check("p34b4_conflict_explicit_reload",bool(wait_for(
            lambda:node_button(page,"episodes","重新读取最新草案（放弃本次输入）"),
            "reload conflicted draft",25)))
        check("p34b4_conflict_reload_displays_current",bool(wait_for(lambda:page.js("""(() => {
            const card=document.querySelector('[data-node-id="episodes"] [aria-label="剧集规划摘要"]');
            return !!card&&!card.querySelector('textarea')&&
              (card.textContent||'').includes('P3.4b4 并发用户更新的标题');
        })()"""),"fresh episode summary after conflict",25)))
        # The prior test deliberately PATCHes an external CAS revision. Reload
        # the current authoritative graph before unrelated scene UI mutations.
        page.call("Page.reload",{"ignoreCache":True})
        check("episode_scene_reloaded_authoritative_graph",bool(wait_for(lambda:page.js("""(() => {
            const nav=performance.getEntriesByType('navigation')[0];
            const summary=document.querySelector('[data-node-id="episodes"] [aria-label="剧集规划摘要"]');
            return nav?.type==='reload'&&!!summary&&
               (summary.textContent||'').includes('已规划 2 集');
        })()"""),"reloaded authoritative scene editor",45)))
        check("episode_scene_editor_reopen",bool(wait_for(
            lambda:node_button(page,"episodes","打开完整编辑器 ↗"),"reopen episode scene editor",25)))
        wait_for(lambda:page.js("""!!document.querySelector('[data-creative-workspace-node-id="episodes"] [data-episode-editor-layout="expanded"]')"""),
                 "episode scene editor ready",25)
        before_scenes=int(page.js("""(() => {
            const root=document.querySelector('[data-creative-workspace-node-id="episodes"] section[aria-label="场次规划"]');
            return root?.querySelectorAll(':scope > details').length ?? -1;
        })()"""))
        check("episode_add_scene_click",node_button(page,"episodes","添加场次"))
        check("episode_added_scene_auto_expanded",bool(wait_for(lambda:page.js("""(() => {
            const root=document.querySelector('[data-creative-workspace-node-id="episodes"] section[aria-label="场次规划"]');
            const scenes=[...(root?.querySelectorAll(':scope > details')||[])];
            const last=scenes.at(-1);
            return scenes.length===%d&&!!last?.open&&
              last.querySelector('input[aria-label^="场次 "]')?.value.startsWith('新场次 ');
        })()"""%(before_scenes+1)),"new episode scene auto expands",25)))
        check("episode_scene_delete_opens_confirmation",bool(page.js("""(() => {
            const root=document.querySelector('[data-creative-workspace-node-id="episodes"] section[aria-label="场次规划"]');
            const last=[...(root?.querySelectorAll(':scope > details')||[])].at(-1);
            const action=last?.querySelector('button[aria-label^="删除场次 "]');
            if(!action)return false;action.click();
            return true;
        })()""")))
        check("episode_scene_cancel_keeps_scene",bool(wait_for(lambda:page.js("""(() => {
            const root=document.querySelector('[data-creative-workspace-node-id="episodes"] section[aria-label="场次规划"]');
            const prompt=root?.querySelector('[role="alertdialog"]');
            const cancel=[...(prompt?.querySelectorAll('button')||[])].find(b=>b.textContent.trim()==='取消');
            if(!cancel)return false;cancel.click();
            return true;
        })()"""),"scene delete confirmation cancel",25)))
        check("episode_scene_cancel_does_not_delete",bool(page.js("""(() => {
            const root=document.querySelector('[data-creative-workspace-node-id="episodes"] section[aria-label="场次规划"]');
            return root?.querySelectorAll(':scope > details').length===%d&&
              !root.querySelector('[role="alertdialog"]');
        })()"""%(before_scenes+1))))
        check("episode_scene_delete_confirmed",bool(wait_for(lambda:page.js("""(() => {
            const root=document.querySelector('[data-creative-workspace-node-id="episodes"] section[aria-label="场次规划"]');
            const last=[...(root?.querySelectorAll(':scope > details')||[])].at(-1);
            const trigger=last?.querySelector('button[aria-label^="删除场次 "]');
            if(!trigger)return false;
            trigger.click();
            const confirm=root.querySelector('button[aria-label^="确认删除场次 "]');
            if(!confirm)return false;
            confirm.click();
            return true;
        })()"""),"confirm remove newly created scene",25)))
        check("episode_scene_removed_without_mutating_other_scenes",bool(wait_for(lambda:page.js("""(() => {
            const root=document.querySelector('[data-creative-workspace-node-id="episodes"] section[aria-label="场次规划"]');
            return root?.querySelectorAll(':scope > details').length===%d&&
              !root.querySelector('[role="alertdialog"]');
        })()"""%before_scenes),"scene returned to previous count",25)))
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
