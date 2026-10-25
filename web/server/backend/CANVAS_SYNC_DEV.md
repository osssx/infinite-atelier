# Local backend Canvas sync (opt-in)

This is an **experimental, manually enabled** bridge between the existing
browser/localforage canvas project and the separate Fastify SQLite project.
It does not replace the existing ComfyUI V2 gateway or migrate all projects.

## Windows development

Open two PowerShell terminals in `web/`:

```powershell
# Terminal A: private Fastify backend on 127.0.0.1:8788
npm run dev:backend

# Terminal B: optional loopback-only Vite proxy to the new backend
$env:ATELIER_BACKEND_URL = "http://127.0.0.1:8788"
npm run dev
```

Open the canvas from **the same Vite origin on localhost**.
Use the top-left canvas menu → **连接本地后端同步（实验性）**.
The backend session is normally already initialized by a local launcher. If not,
paste the **single-use** token printed by Terminal A into the prompted
password input. The token goes only to `POST /api/v1/session` as a Bearer
header, is never placed into an API URL, Vite environment variable,
project document or LocalStorage, and is invalid after successful exchange.
Do not copy the token into Git or logs.

The Vite proxy is disabled without `ATELIER_BACKEND_URL`, allows only
an exact loopback HTTP origin with an explicit port, forwards the original
Host and Origin for Fastify's CSRF checks, and refuses LAN clients.
Existing `/api/comfy` routes are unchanged.

## Behavior and limitations

- Connecting is **explicit**. When the backend has no project under the
  existing canvas ID, it creates a separate backend copy of graph nodes and
  connections. No existing localforage project is deleted.
- A matching saved remote baseline is mandatory; incoming server artifacts
  may append new typed resource nodes and Comfy output edges.
- Canvas edits use debounced `PATCH /api/v1/projects/:id` with `If-Match`
  and expected revision. Backend events are replayed via `/api/v1/events`
  from the jobs snapshot cursor; expiry obtains a new snapshot.
- Local unsaved edits are never silently replaced. Concurrent changes enter
  **同步冲突**. An explicit **尝试安全合并后端生成产物** action can merge
  artifact-only remote additions when the originating workflow nodes
  have not been changed locally. Otherwise the local draft is preserved.
- Other project fields (viewport, chat history, display title) remain
  locally managed for now. The bridge does not initiate generation requests;
  it observes completed backend materializations only.
- `dev:backend` defaults to no adapters and no autoDispatch. For real
  generation use the explicit backend adapter/runtime configuration; the old
  V2 gateway remains the default application execution route.
- This is a single-machine session and experimental feature, not a
  multi-user conflict-free collaborative editor or production launcher.
