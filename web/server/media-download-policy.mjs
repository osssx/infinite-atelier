const MEDIA_CONTENT_TYPE = /^(?:video|audio|image)\/[a-z0-9.+-]+$|^application\/octet-stream$/;

export function classifyMediaDownloadResponse({ statusCode, contentType = "" }) {
    if (statusCode === 404 || statusCode === 410) {
        return { ok: false, status: statusCode, body: { code: "MEDIA_URL_EXPIRED", error: "Media URL expired or is no longer available." } };
    }
    if (statusCode < 200 || statusCode >= 300) {
        return { ok: false, status: 502, body: { code: "MEDIA_DOWNLOAD_FAILED", error: `Media source failed (${statusCode}).` } };
    }
    const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (!MEDIA_CONTENT_TYPE.test(normalizedType)) {
        return { ok: false, status: 502, body: { code: "MEDIA_NOT_MEDIA", error: "Media source returned an unsupported content type." } };
    }
    return { ok: true, contentType: normalizedType };
}
