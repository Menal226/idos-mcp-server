import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { CHARACTER_LIMIT, DEFAULT_TIMETABLE } from "./constants.js";
import { IdosError } from "./http.js";

export enum ResponseFormat {
    MARKDOWN = "markdown",
    JSON = "json"
}

export const responseFormatSchema = z
    .enum(ResponseFormat)
    .default(ResponseFormat.MARKDOWN)
    .describe("'markdown' for readable text (default), 'json' for structured data");

export const timetableSchema = z
    .string()
    .regex(/^[a-z0-9]+$/, "Lowercase letters and digits only, e.g. 'vlakyautobusymhdvse', 'vlaky', 'autobusy', 'pid'")
    .default(DEFAULT_TIMETABLE)
    .describe(
        "IDOS timetable combination (URL segment). Default 'vlakyautobusymhdvse' = all trains, buses and city transport. Others: 'vlaky' (trains only), 'autobusy' (long-distance buses), 'pid' (Prague integrated transport), 'idsjmk' (Brno region)."
    );

export const dateSchema = z
    .string()
    .regex(/^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\.\s?\d{1,2}\.\s?(\d{4})?)$/, "Use YYYY-MM-DD or D.M.YYYY")
    .optional()
    .describe("Date as YYYY-MM-DD (e.g. '2026-11-07') or Czech D.M.YYYY. Omit for today.");

export const timeSchema = z
    .string()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)")
    .optional()
    .describe("Time as HH:MM, 24-hour (e.g. '07:30'). Omit for now.");

export const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
} as const;

/** YYYY-MM-DD in Europe/Prague. */
export function todayInPrague(): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
}

/** YYYY-MM-DD or D.M.YYYY to the D.M.YYYY form IDOS expects. */
export function toIdosDate(date: string | undefined): string | undefined {
    if (!date) return undefined;
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date);
    if (iso) return `${Number(iso[3])}.${Number(iso[2])}.${iso[1]}`;
    return date.replace(/\s+/g, "");
}

export function clean(text: string | undefined | null): string {
    return (text ?? "").replace(/[\s ]+/g, " ").trim();
}

/** Lowercase, no diacritics, single spaces: for forgiving name comparisons. */
export function fold(text: string): string {
    return clean(
        text
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
    );
}

/** Like `fold`, but also drops spaces and punctuation that IDOS uses inconsistently in stop names. */
export function compact(text: string): string {
    return fold(text).replace(/[\s.,;\-_()]+/g, "");
}

/** Opaque base64url tokens (page tokens, trip ids) passed between tool calls. */
export function encodeToken(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeToken<T>(token: string): T | undefined {
    try {
        return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as T;
    } catch {
        return undefined;
    }
}

/** An error whose message is written for the model. */
export class ToolError extends Error {}

export function textResult(text: string): CallToolResult {
    return { content: [{ type: "text", text }] };
}

export function jsonResult(data: Record<string, unknown>): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

export function errorResult(text: string): CallToolResult {
    return { content: [{ type: "text", text }], isError: true };
}

/** Turns ToolError / IdosError into an isError result; anything else (including aborts) propagates. */
export function toolErrorResult(error: unknown): CallToolResult {
    if (error instanceof ToolError || error instanceof IdosError) return errorResult(error.message);
    throw error;
}

/** Largest n <= total whose rendering fits in CHARACTER_LIMIT (at least 1 when total > 0). */
export function largestFittingCount(total: number, render: (n: number) => string): number {
    if (total === 0 || render(total).length <= CHARACTER_LIMIT) return total;
    let lo = 1;
    let hi = total - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (render(mid).length <= CHARACTER_LIMIT) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/** Renders as many leading items as fit in CHARACTER_LIMIT, never cutting an item in half. */
export function fitToLimit<T>(items: T[], render: (shown: T[]) => string): { text: string; shown: number } {
    const shown = largestFittingCount(items.length, n => render(items.slice(0, n)));
    return { text: render(items.slice(0, shown)), shown };
}
