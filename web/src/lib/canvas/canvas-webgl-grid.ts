import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { ViewportTransform } from "@/types/canvas";

export type WebGLGridSize = { width: number; height: number; dpr: number };
export type WebGLGridColors = { line: string; dot: string };

export type WebGLGridRenderer = {
    draw(viewport: ViewportTransform, mode: CanvasBackgroundMode, colors: WebGLGridColors, size: WebGLGridSize): void;
    destroy(): void;
};

export type RgbaColor = { r: number; g: number; b: number; a: number };

export function parseCssGridColor(value: string): RgbaColor | null {
    const rgba = value.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (rgba) {
        const channels = rgba.slice(1, 4).map(Number);
        const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
        if (![...channels, alpha].every(Number.isFinite)) return null;
        return {
            r: Math.min(255, Math.max(0, channels[0])) / 255,
            g: Math.min(255, Math.max(0, channels[1])) / 255,
            b: Math.min(255, Math.max(0, channels[2])) / 255,
            a: Math.min(1, Math.max(0, alpha)),
        };
    }
    const hex = value.trim().match(/^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
    if (!hex) return null;
    const expanded = hex.length <= 4 ? [...hex].map((char) => char + char).join("") : hex;
    const hasAlpha = expanded.length === 8;
    return {
        r: parseInt(expanded.slice(0, 2), 16) / 255,
        g: parseInt(expanded.slice(2, 4), 16) / 255,
        b: parseInt(expanded.slice(4, 6), 16) / 255,
        a: hasAlpha ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
}

const VERTEX_SHADER = `#version 300 es
void main() {
    vec2 point = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(point * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 outputColor;
uniform vec3 viewport;
uniform vec2 sizeCss;
uniform float dpr;
uniform int mode;
uniform vec4 lineColor;
uniform vec4 dotColor;

void main() {
    vec2 screen = vec2(gl_FragCoord.x / dpr, (sizeCss.y * dpr - gl_FragCoord.y) / dpr);
    float spacing = 48.0 * viewport.z;
    vec2 phase = mod(screen - mod(viewport.xy, spacing), spacing);
    if (mode == 1) {
        float radius = viewport.z < 0.12 ? 0.8 : 1.15;
        float distanceFromDot = length(phase - vec2(spacing * 0.5));
        float coverage = 1.0 - smoothstep(radius - 0.5 / dpr, radius + 0.2 + 0.5 / dpr, distanceFromDot);
        float alpha = dotColor.a * 0.4 * coverage;
        outputColor = vec4(dotColor.rgb * alpha, alpha);
        return;
    }
    vec2 distanceToLine = abs(mod(screen - viewport.xy - vec2(0.5) + vec2(spacing * 0.5), spacing) - spacing * 0.5);
    vec2 coverage = clamp((vec2(0.5 + 0.5 / dpr) - distanceToLine) * dpr, 0.0, 1.0);
    float verticalAlpha = lineColor.a * coverage.x;
    float horizontalAlpha = lineColor.a * coverage.y;
    float alpha = (verticalAlpha + horizontalAlpha * (1.0 - verticalAlpha)) * 0.4;
    outputColor = vec4(lineColor.rgb * alpha, alpha);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

export function createWebGLGridRenderer(canvas: HTMLCanvasElement): WebGLGridRenderer | null {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) {
        if (vertex) gl.deleteShader(vertex);
        if (fragment) gl.deleteShader(fragment);
        return null;
    }
    const program = gl.createProgram();
    if (!program) {
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        return null;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        return null;
    }
    const vao = gl.createVertexArray();
    if (!vao) {
        gl.deleteProgram(program);
        return null;
    }
    const uniforms = {
        viewport: gl.getUniformLocation(program, "viewport"),
        sizeCss: gl.getUniformLocation(program, "sizeCss"),
        dpr: gl.getUniformLocation(program, "dpr"),
        mode: gl.getUniformLocation(program, "mode"),
        lineColor: gl.getUniformLocation(program, "lineColor"),
        dotColor: gl.getUniformLocation(program, "dotColor"),
    };
    if (Object.values(uniforms).some((uniform) => uniform === null)) {
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
        return null;
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    let lastSignature = "";
    let lastLineCss = "";
    let lastDotCss = "";
    let lineUniform: RgbaColor | null = null;
    let dotUniform: RgbaColor | null = null;
    let destroyed = false;
    return {
        draw(viewport, mode, colors, size) {
            if (destroyed || mode === "blank" || size.width <= 0 || size.height <= 0) return;
            const dpr = Math.min(2, Math.max(1, Number.isFinite(size.dpr) ? size.dpr : 1));
            const backingWidth = Math.max(1, Math.ceil(size.width * dpr));
            const backingHeight = Math.max(1, Math.ceil(size.height * dpr));
            const backingChanged = canvas.width !== backingWidth || canvas.height !== backingHeight;
            if (canvas.width !== backingWidth) canvas.width = backingWidth;
            if (canvas.height !== backingHeight) canvas.height = backingHeight;
            const signature = `${viewport.x}|${viewport.y}|${viewport.k}|${mode}|${colors.line}|${colors.dot}|${size.width}|${size.height}|${dpr}`;
            if (!backingChanged && signature === lastSignature) return;
            lastSignature = signature;
            if (colors.line !== lastLineCss) {
                lastLineCss = colors.line;
                lineUniform = parseCssGridColor(colors.line);
            }
            if (colors.dot !== lastDotCss) {
                lastDotCss = colors.dot;
                dotUniform = parseCssGridColor(colors.dot);
            }
            if (!lineUniform || !dotUniform) return;
            gl.viewport(0, 0, backingWidth, backingHeight);
            gl.useProgram(program);
            gl.bindVertexArray(vao);
            gl.uniform3f(uniforms.viewport, viewport.x, viewport.y, viewport.k);
            gl.uniform2f(uniforms.sizeCss, size.width, size.height);
            gl.uniform1f(uniforms.dpr, dpr);
            gl.uniform1i(uniforms.mode, mode === "dots" ? 1 : 0);
            gl.uniform4f(uniforms.lineColor, lineUniform.r, lineUniform.g, lineUniform.b, lineUniform.a);
            gl.uniform4f(uniforms.dotColor, dotUniform.r, dotUniform.g, dotUniform.b, dotUniform.a);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            gl.deleteVertexArray(vao);
            gl.deleteProgram(program);
        },
    };
}
