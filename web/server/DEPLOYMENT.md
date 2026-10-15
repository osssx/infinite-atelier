# Ark media gateway

The browser cannot give Ark a `blob:` URL. Run `ark-gateway.mjs` behind your HTTPS reverse proxy and route `/api/media/uploads` and `/api/ark/*` to it. The default upstream is `https://ark.cn-beijing.volces.com/api/v3`. Custom HTTPS upstreams are supported only when their exact host is listed in `ARK_ALLOWED_HOSTS`; request-supplied `x-ark-base-url` values are checked against that same list and pinned to validated public DNS answers. It requires a shared `x-gateway-token` on every route. A local deployment can set `VITE_MEDIA_GATEWAY_TOKEN` for the frontend, but every `VITE_*` value is visible to browser users and is not a secret. For a public multi-user deployment, enforce user authentication and rate limits at the reverse proxy, inject `x-gateway-token` from that trusted layer, set the non-secret build flag `VITE_ARK_SERVER_AUTH=true`, and configure `ARK_API_KEY` on the server so users do not supply or store Ark credentials in the browser. The frontend sends an empty gateway-token header in this setup; the trusted reverse proxy must overwrite it with the server-side `GATEWAY_TOKEN` for `/api/ark/*` and `/api/media/uploads`.

## Run

Use Node.js 20 or newer. From `web/`, set the following environment variables in the service manager or container secret store, then run `node server/ark-gateway.mjs`:

For a local PowerShell setup, create the private environment files with placeholders and then load the server values into the current shell. Replace the example token and key locally; never commit either file.

```powershell
@'
GATEWAY_TOKEN=replace-with-a-long-random-token
ARK_API_KEY=replace-with-your-Ark-key
MEDIA_UPLOAD_URL=https://your-upload-adapter.example/upload
'@ | Set-Content -Encoding ascii .env

Get-Content .env | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$env:VITE_MEDIA_GATEWAY_TOKEN = $env:GATEWAY_TOKEN
node server/ark-gateway.mjs
```

In another PowerShell window, write the same gateway token to Vite's local-only environment file before starting the frontend:

```powershell
@'
VITE_MEDIA_GATEWAY_TOKEN=replace-with-the-same-long-random-token
VITE_ARK_SERVER_AUTH=false
'@ | Set-Content -Encoding ascii .env.local
npm run dev
```

For a public server-key deployment, replace `VITE_MEDIA_GATEWAY_TOKEN` with no usable shared secret and set `VITE_ARK_SERVER_AUTH=true` in `.env.local` before building. Configure the reverse proxy to overwrite the empty `x-gateway-token` header with its secret value. This flag only allows the UI to accept an empty channel key; it contains no credential and does not grant gateway access by itself.

The health-check button queries a fixed task ID that this integration never creates. An authenticated Ark 404 is treated as a successful reachability check, while Ark 401/403 and gateway authentication errors are shown separately. It does not create a task or generate a video.

| Variable | Required | Meaning |
| --- | --- | --- |
| `GATEWAY_TOKEN` | yes | Shared gateway credential checked in the `x-gateway-token` header. Do not expose it in logs. |
| `ARK_API_KEY` | for shared deployments | Ark bearer key held by the server. If omitted, an authenticated client request must provide `Authorization: Bearer ...`. |
| `ARK_BASE_URL` | no | HTTPS Ark API base URL, defaults to `https://ark.cn-beijing.volces.com/api/v3`. The URL cannot contain credentials, query, fragment, or a non-443 port. |
| `ARK_ALLOWED_HOSTS` | required for a custom public base | Comma-separated exact HTTPS hostnames allowed for `ARK_BASE_URL` and request `x-ark-base-url`; defaults to `ark.cn-beijing.volces.com`. Include the official Ark hostname too if both official and custom channels are used. Wildcards and IP literals are not accepted. |
| `ARK_TRUSTED_BASE_URLS` | optional local integration | Comma-separated exact HTTP loopback API base URLs, including explicit port and API path, such as `http://127.0.0.1:8189/api/v3`. These are the only private destinations the gateway accepts for Ark protocol requests. DNS must resolve only to loopback. |
| `MEDIA_UPLOAD_URL` | for local reference media | Fixed HTTPS upload adapter endpoint, or an explicit loopback HTTP endpoint. The gateway POSTs multipart field `file` to this configured URL. The adapter returns JSON `{ "url": "https://..." }` or a signed URL on the exact trusted loopback upload origin. |
| `MEDIA_UPLOAD_FORWARD_CLIENT_AUTH` | optional | Set to `1` to forward the selected channel's `Authorization` header to the configured upload endpoint when `MEDIA_UPLOAD_TOKEN` is unset. Use only for a trusted upload service that requires the channel key. |
| `MEDIA_UPLOAD_ALLOWED_HOSTS` | no | Comma-separated exact hostnames permitted for `MEDIA_UPLOAD_URL`; defaults to that URL's hostname. |
| `MEDIA_PUBLIC_ALLOWED_HOSTS` | no | Comma-separated exact public hostnames the adapter may return as media URLs; defaults to the upload endpoint hostname. Include your public object-storage/CDN host when it differs. |
| `MEDIA_UPLOAD_TOKEN` | no | Bearer token sent to the configured upload adapter. |
| `MEDIA_UPLOAD_METHOD` | no | Upload adapter method, defaults to `POST`. |
| `MEDIA_MAX_BYTES` | no | Maximum file bytes, defaults to 200 MiB; the gateway permits an additional 256 KiB for multipart boundaries and form fields. |
| `MEDIA_UPLOAD_TIMEOUT_MS` | no | Upload adapter timeout, defaults to 60 seconds. |
| `MEDIA_DOWNLOAD_ALLOWED_HOSTS` | no | Exact Ark result/CDN hostnames permitted by the server-side download route; defaults to `ark.cn-beijing.volces.com,ark-content-generation-cn-beijing.tos-cn-beijing.volces.com`. Add the exact HTTPS hostnames returned in your Ark results if needed. |
| `MEDIA_DOWNLOAD_MAX_BYTES` | no | Maximum downloaded result size, defaults to 200 MiB. |
| `MEDIA_DOWNLOAD_TIMEOUT_MS` | no | Result download timeout, defaults to 60 seconds. |
| `GATEWAY_HOST` | no | Bind address, defaults to `127.0.0.1`; use `0.0.0.0` only when a reverse proxy/container requires it and protect the service with network policy. |
| `PORT` | no | Listen port, defaults to `8787`. |

The upload adapter is the storage-specific part of deployment: implement it against your TOS/S3-compatible service or a trusted signed-upload service. It must store the uploaded object and return a short-lived signed media URL that Ark can fetch. A loopback API may return a signed HTTP URL only when its exact API base is listed in `ARK_TRUSTED_BASE_URLS`. The gateway deliberately has no default public bucket or upload destination. Do not point it at an endpoint that accepts arbitrary destination URLs from request fields.

Expose the service only through HTTPS. Configure the reverse proxy to cap request bodies at `MEDIA_MAX_BYTES` plus multipart overhead, retain the `/api/media/uploads` and `/api/ark` paths, and avoid access logs containing query strings or authorization headers. The gateway independently limits bodies (64 MiB for task API input and 200 MiB per uploaded/downloaded media file), responses, methods and timeouts, rejects redirects, validates public HTTPS destinations against exact host allowlists, and permits private destinations only when they exactly match explicit loopback configuration. Ark API, upload-adapter and result-download connections pin the validated DNS addresses. Give the process no cloud credentials beyond the narrowly scoped upload service credential and (when configured) the Ark key.

## Local development

Run the gateway with the same required configuration, then run Vite. Vite uses the same generic `/api/ark/*` and `/api/media/uploads` routes in local development. Set `ARK_TRUSTED_BASE_URLS` to the exact loopback Ark API URL and `MEDIA_UPLOAD_URL` to its generic multipart upload endpoint. The dev middleware requires same-origin browser requests from a loopback client, pins loopback DNS, rejects redirects, and allows only fixed Ark routes and signed media paths. For public HTTPS Ark channels, run the gateway and set `MEDIA_GATEWAY_URL` if it is not at `http://127.0.0.1:8787`. The legacy `/api-proxy?target=...` dev helper permits HTTPS hosts listed in `VITE_API_PROXY_ALLOWED_HOSTS`; the default includes Ark, OpenAI, and Google Gemini API hosts. Add exact, trusted relay/provider hostnames as a comma-separated list for local work, for example `VITE_API_PROXY_ALLOWED_HOSTS=ark.cn-beijing.volces.com,api.openai.com,generativelanguage.googleapis.com,relay.example.com`. IP literals, non-HTTPS targets, private DNS answers, redirects, and oversized bodies are rejected. Since Vite listens on all interfaces in this project, keep this dev server on a trusted network; the host allowlist is active in all cases.

## Routes

- `POST /api/media/uploads`: generic multipart upload service; field `file`; returns `{ "url": "..." }`.
- `POST /media/ark` and `/api/media/ark`: legacy upload aliases.
- `POST /api/ark/contents/generations/tasks`: create an Ark task.
- `GET` or `DELETE /api/ark/contents/generations/tasks/{taskId}`: query or cancel a task.
- `GET /api/ark/download?url={encoded-signed-url}`: bounded server-side result download. The hostname must appear in `MEDIA_DOWNLOAD_ALLOWED_HOSTS`.

Gateway routes require the gateway token. The server sends only supported task routes to the configured allowlisted Ark API origin. The Vite development transport uses the same Ark and generic upload paths and enforces browser same-origin checks for explicitly configured loopback destinations. Configure CORS at the reverse proxy only if the browser is intentionally hosted on another origin; allow that exact origin and required headers, never `*` with credentials.
