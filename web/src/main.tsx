import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { router } from "@/router";

// Perf-mode entry point. `import.meta.env.MODE` is inlined at build time, so in a normal build this
// block — and the dynamic import inside it — is dead code, and no perf chunk is emitted.
// Runs before the render below, but the bootstrap itself awaits hydration before it injects anything.
if (import.meta.env.MODE === "perf") {
    // Support direct repeatable 200-node interaction smoke tests in the perf build only.
    // Do not change the default 1000-node benchmark workload.
    const requested = Number(new URLSearchParams(window.location.search).get("perfNodes"));
    const nodes = Number.isInteger(requested) && requested >= 1 && requested <= 3000 ? requested : 1000;
    const mediaMode = new URLSearchParams(window.location.search).get("perfMedia") === "decoded" ? "decoded" : "static";
    void import("@/lib/canvas/canvas-perf-harness").then((harness) => harness.bootstrapCanvasPerf(nodes, mediaMode));
}

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </React.StrictMode>,
);
