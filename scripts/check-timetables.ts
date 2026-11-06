/** Live check of the timetable tools against idos.cz: npx tsx scripts/check-timetables.ts */
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { registerTimetableTools } from "../src/tools/timetables.js";

type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<CallToolResult>;
type Schema = { parse(input: unknown): Record<string, unknown> };

const tools = new Map<string, { schema: Schema; handler: Handler }>();
registerTimetableTools({
    registerTool(name: string, config: { inputSchema: Schema }, handler: Handler) {
        tools.set(name, { schema: config.inputSchema, handler });
    }
} as unknown as McpServer);

let failures = 0;
async function call(name: string, input: Record<string, unknown>, expect: "ok" | "error" = "ok", maxChars = 1800) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    const started = Date.now();
    const result = await tool.handler(tool.schema.parse(input), { mcpReq: { signal: AbortSignal.timeout(120_000) } });
    const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
    const ok = expect === "error" ? result.isError === true : !result.isError;
    if (!ok) failures++;
    console.log(
        `\n=== ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(input)} (${Date.now() - started} ms, ${text.length} chars${result.isError ? ", isError" : ""})`
    );
    console.log(text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated]` : text);
}

const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(Date.now() + 24 * 3600 * 1000);
console.log(`Registered tools: ${[...tools.keys()].join(", ")}; using date ${date}`);

await call("idos_list_city_timetables", {}, "ok", 900);
await call("idos_search_lines", { city: "Praha", query: "136" });
await call("idos_search_lines", { city: "Brno", query: "1", response_format: "json" }, "ok", 900);
await call("idos_get_line_route", { city: "Praha", line: "136", direction: "Jižní Město", date });
await call("idos_get_stop_timetable", { city: "Praha", line: "136", stop: "Flora", direction: "Jižní Město", date });
await call("idos_get_stop_timetable", { city: "Brno", line: "1", stop: "Hlavní nádraží", whole_week: true }, "ok", 2500);
await call("idos_get_stop_timetable", { city: "Praha", line: "136", stop: "Florenc", direction: "Jižní Město" }, "error");
await call("idos_get_stop_timetable", { city: "Gotham", line: "1", stop: "Main St", direction: "Central" }, "error");
await call("idos_get_train_route", { train: "RJ 1031", station: "Praha hl.n.", date, time: "06:00" }, "ok", 2500);
await call(
    "idos_get_train_route",
    { train: "Pendolino", station: "Ostrava hl.n.", date, time: "08:30", response_format: "json" },
    "ok",
    1500
);
await call("idos_get_train_route", { train: "EC 144", station: "Ostrava hl.n.", date, time: "08:00", response_format: "json" }, "ok", 1500);
await call("idos_get_train_route", { train: "219", station: "Praha,,Florenc", date, time: "08:00", timetable: "autobusy" }, "ok", 1200);
await call("idos_get_train_route", { train: "R 99999", station: "Praha hl.n.", date, time: "06:00", max_pages: 1 }, "error");
await call("idos_get_train_route", { train: "R 871", station: "Praha hlxx", date }, "error");

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exitCode = failures === 0 ? 0 : 1;
