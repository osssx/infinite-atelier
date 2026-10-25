# Local backend Canvas sync (opt-in)

This is an **experimental, explicitly enabled** bridge between origin-local
browser/IndexedDB canvas projects and one shared Fastify SQLite project library.
It does not replace the existing ComfyUI V2 gateway, and does not silently
migrate or delete all local projects.

## Windows development

Open two PowerShell terminals in `web/`:

```powershell
# Terminal A: private Fastify backend on 127.0.0.1:8788
npm run dev:backend

# Terminal B: optional loopback-only Vite proxy to the new backend
$env:ATELIER_BACKEND_URL = "http://127.0.0.1:8788"
npm run dev
```

Open the canvas on either `http://127.0.0.1:<vite-port>` or
`http://localhost:<vite-port>` (as permitted by the Vite listener).
Use the canvas library **共享后端项目库（实验性）** to discover existing
backend projects, or the canvas top-left menu **连接本地后端同步（实验性）**
to publish a currently open local project.
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




## Shared project list and cross-origin edits (schema v6)

**Restart `npm run dev:backend` once** after updating: schema v6 adds
a durable `project_events` feed. Do not restart while GPU tasks are active.

- Each browser origin has **independent** IndexedDB, LocalStorage and
  session cookies. Log in from each hostname separately with a *different*
  fresh single-use token; the two origins then see the **same** backend
  project list and SQLite project revisions.
- On the first origin, open an existing local project and choose
  **连接本地后端同步（实验性）**. This creates its backend copy with
  the original project ID, title and typed graph; it does not delete the
  browser copy. No other local projects are uploaded automatically.
- On the second origin, open the canvas library, choose
  **连接共享项目库**, then **打开共享项目**. The backend snapshot
  becomes that origin's **new IndexedDB cache using the same project ID**.
  When a conflicting local project already has that ID, the import
  fails closed: nothing is replaced.
- Once the page connects (automatically on subsequent opens after explicit
  opt-in), debounced edits to ordinary canvas nodes, connections and title
  are saved by `PATCH` with optimistic revision validation. The
  `/api/v1/projects/events` SSE feed broadcasts committed creates,
  edits and artifact materializations. Missed events are replayed after
  reconnect; an expired cursor obtains a fresh snapshot.
- **Dirty local edits never get silently replaced.** If another origin
  saves first, the other view enters **同步冲突** and keeps its local
  draft in IndexedDB. Its generation save barrier remains blocked until
  versions are reconciled. There is no CRDT or multi-user simultaneous
  editing; avoid typing into the same node from both tabs at once.
- Existing image/media files referenced by origin-local storage keys
  are *not* automatically transferred with the project JSON. Previously
  uploaded backend BlobStore artifacts remain accessible via same-origin
  authenticated `/api/v1/blobs/` URLs. Transfer/ingest other media before
  relying on cross-origin previews; do not delete the original local cache.
- Viewport, chat sessions, user preferences and other local-only state
  are not cross-origin collaborative data in this stage. The project
  list, canvas graph and title use the backend as the authoritative
  **synchronized** source only for opted-in projects.

## Troubleshooting: invalid_project_document

The old backend validator rejected ordinary canvas node IDs such as
`comfy:workflow-1792758417919-co36n` because they contain a colon.
The updated backend accepts plugin-derived node IDs (including `:`, `.`,
`@`, `/`) without changing or regenerating them. Target-node API
validation and Comfy request compilation use the same node-ID rules.

**Restart `npm run dev:backend` once** after upgrading these files,
otherwise the still-running server retains the old validation code.
Do not restart while GPU submissions are active.

If the error persists with the updated backend, check the `details.reason`
and index in the JSON response from `POST /api/v1/projects`. The frontend
now explains the affected node or connection index (1-based). It does not
remove or rewrite dangling links, repeated IDs or invalid nodes; preserve
the local copy and repair the particular reference instead.

## Troubleshooting: invalid_bootstrap_token

A bootstrap token is **valid for only five minutes** and is invalidated
immediately after a successful login. The token printed when the backend
was first started will not work after five minutes even if copied exactly.

On a current interactive `npm run dev:backend` terminal, type **r** and
press **Enter** to obtain a new one-time token (the previous token is
immediately invalidated). Paste only the fresh token into the Canvas
login dialog within five minutes. Already authenticated sessions stay valid.

When upgrading from a backend process started before terminal renewal
was implemented, **restart that backend once** before using the `r`
command. Check for active GPU generation jobs before restarting.

The renewal command is available only on the backend's interactive
terminal. There is deliberately no public token refresh API and no
token storage in the canvas project or browser LocalStorage.

## Troubleshooting: backend_proxy_not_configured / backend_invalid_json

When `/api/v1/session` on the **Vite** origin returns HTML instead of
JSON, it means Vite was started without the private backend proxy. A running
backend on `127.0.0.1:8788` alone does not enable this proxy.

**Stop the existing Vite process** (usually port 3000). In the same
PowerShell terminal used to start Vite, run:

```powershell
cd E:\WebDev\infinite-atelier\web
$env:ATELIER_BACKEND_URL = "http://127.0.0.1:8788"
npm run dev
```

Verify `http://127.0.0.1:3000/api/v1/session` returns JSON (a 401
`unauthorized` response before login is expected). It must not return the
HTML Canvas UI. Then refresh the Canvas page and retry the sync menu.

Recent builds return a clear JSON `503 backend_proxy_not_configured`
when the dev proxy is missing instead of allowing the Vite SPA fallback
to mask the issue.

## Opt-in ComfyUI generation through the new backend

With a ComfyUI server listening on a loopback URL, start Terminal A as:

```powershell
$env:ATELIER_COMFY_INSTANCE_ID = "comfy-local"
$env:ATELIER_COMFY_URL = "http://127.0.0.1:8188"
npm run dev:backend
```

The instance ID must match the selected Comfy instance in the UI's global
preferences. Backend configuration fails closed for untrusted destinations,
and browser submission checks `GET /api/v1/execution/capabilities` before
staging media or submitting a paid generation. Both the instance and
automatic dispatch must be configured.

After connecting project sync, choose
**ComfyUI 执行：原 V2（点击试用新后端）** from the canvas top-left menu.
Only then does the regular workflow-node **开始生成** action use
the new JobCoordinator. Switching away or reloading restores the old V2
default; already accepted backend jobs continue until terminal status.

The new submission sequence is:

1. Freeze the graph and typed external scalar/media inputs.
2. Upload reference image blobs to the private BlobStore by content hash.
3. Flush and verify the frozen project graph; read its durable revision,
   and compute its transitive source fingerprint, identical to the server.
4. Persist the idempotent job request in local browser storage **before**
   the first `POST /api/v1/jobs`, then remove the pending request only
   after an acknowledged HTTP response.
5. The new backend independently verifies revision and fingerprint
   before queuing. A lost response can be replayed with the **same** key
   and complete frozen snapshot. The source node is **not** edited merely
   to display transient execution status; this protects materialization.
6. The Worker captures image/video/audio/text artifacts, and CanvasMaterializer
   appends typed nodes/edges transactionally. Frontend SSE project sync
   imports those changes only when doing so cannot overwrite local edits.

The last accepted backend job ID is kept separately from the project document,
so the workflow inspector can refresh the job status after reopening.
For now, backend job cancellation is not exposed in the old V2 inspector:
its existing cancel API is for the **old** V2 gateway, not the new JobCoordinator.

Real GPU execution and the full browser visual workflow have not been validated
on every machine. Existing automated tests use isolated fake ComfyUI instances;
run a manual end-to-end smoke test on the target Comfy installation before
replacing any production flow.

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
  locally managed for now. The sync bridge observes backend materializations
  and, only when the separate Comfy execution switch is on, submits jobs
  through the durable generation save barrier.
- `dev:backend` defaults to no adapters and no autoDispatch. Setting both
  `ATELIER_COMFY_INSTANCE_ID` and `ATELIER_COMFY_URL` opt-in to local
  Comfy execution. Without the two opt-ins the old V2 gateway remains
  the default application generation route.
- This is a single-machine session and experimental feature, not a
  multi-user conflict-free collaborative editor or production launcher.
