/**
 * Live check of idos_search_connections / idos_get_connection_detail against https://idos.cz.
 * Run: npx tsx scripts/check-connections.ts
 * Calls the tool handlers through a fake McpServer, so schemas and defaults are exercised too.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { registerConnectionTools } from "../src/tools/connections.js";

type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<CallToolResult>;
interface Registered {
    schema: { parse: (v: unknown) => Record<string, unknown> };
    handler: Handler;
}

const tools = new Map<string, Registered>();
const fakeServer = {
    registerTool(name: string, config: { inputSchema: Registered["schema"] }, handler: Handler) {
        tools.set(name, { schema: config.inputSchema, handler });
    }
};
registerConnectionTools(fakeServer as never);

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    const parsed = tool.schema.parse(args);
    return tool.handler(parsed, { mcpReq: { signal: AbortSignal.timeout(120_000) } });
}

function text(result: CallToolResult): string {
    return result.content.map(c => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

function tomorrow(): string {
    const d = new Date(Date.now() + 86_400_000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);
}

let failures = 0;
function check(label: string, ok: boolean, info = ""): void {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${info ? ` — ${info}` : ""}`);
    if (!ok) failures++;
}

function section(title: string): void {
    console.log(`\n${"=".repeat(100)}\n${title}\n${"=".repeat(100)}`);
}

const date = tomorrow();
console.log(`Registered tools: ${[...tools.keys()].join(", ")}; date used: ${date}`);

section("1. Praha -> Brno tomorrow 08:00 (markdown, count 4)");
const md = await call("idos_search_connections", { from: "Praha", to: "Brno", date, time: "08:00", count: 4 });
console.log(text(md));
check("markdown search ok", !md.isError && /## 1\./.test(text(md)));

section("2. Praha -> Brno tomorrow 08:00 (json)");
const js = await call("idos_search_connections", { from: "Praha", to: "Brno", date, time: "08:00", response_format: "json" });
const data = js.structuredContent as {
    connections: { connection_id: string; departure: { datetime: string }; arrival: { datetime: string }; legs: unknown[] }[];
    next_page_token?: string;
    prev_page_token?: string;
};
console.log(JSON.stringify(data.connections[0], null, 2).slice(0, 2500));
check("json has 5 connections", data.connections.length === 5, `${data.connections.length}`);
check(
    "json sorted by departure",
    data.connections.every((c, i, a) => i === 0 || a[i - 1].departure.datetime <= c.departure.datetime)
);
check("tokens present", Boolean(data.next_page_token && data.prev_page_token));

section("3. Paging: next page and previous page");
const lastDep = data.connections.at(-1)!.departure.datetime;
const firstArr = data.connections.map(c => c.arrival.datetime).sort()[0];
const nextPage = await call("idos_search_connections", { page_token: data.next_page_token, count: 3, response_format: "json" });
const nextConns = (nextPage.structuredContent as typeof data).connections;
console.log("next:", nextConns.map(c => `${c.departure.datetime} -> ${c.arrival.datetime}`).join(" | "));
check("next page departs at/after last shown", nextConns.length > 0 && nextConns.every(c => c.departure.datetime >= lastDep));
check(
    "next page has no duplicates",
    nextConns.every(c => !data.connections.some(d => d.connection_id === c.connection_id))
);
const prevPage = await call("idos_search_connections", { page_token: data.prev_page_token, count: 3, response_format: "json" });
const prevConns = (prevPage.structuredContent as typeof data).connections;
console.log("prev:", prevConns.map(c => `${c.departure.datetime} -> ${c.arrival.datetime}`).join(" | "));
check("prev page arrives at/before first shown arrival", prevConns.length > 0 && prevConns.every(c => c.arrival.datetime <= firstArr));

section("4. Arrival search: Praha hl.n. -> Ostrava, arrive by 18:00 tomorrow");
const arr = await call("idos_search_connections", { from: "Praha hl.n.", to: "Ostrava", date, time: "18:00", arrival: true, count: 3 });
console.log(text(arr));
const arrJson = await call("idos_search_connections", {
    from: "Praha hl.n.",
    to: "Ostrava",
    date,
    time: "18:00",
    arrival: true,
    count: 3,
    response_format: "json"
});
const arrConns = (arrJson.structuredContent as typeof data).connections;
check("all arrive by 18:00", arrConns.length > 0 && arrConns.every(c => c.arrival.datetime <= `${date}T18:00`));

section("5. Via: Praha -> Brno via Jihlava, max 1 change");
const via = await call("idos_search_connections", {
    from: "Praha",
    to: "Brno",
    via: ["Jihlava"],
    max_changes: 1,
    date,
    time: "08:00",
    count: 3
});
console.log(text(via));
check("via search ok", !via.isError && /via Jihlava/.test(text(via)));

section("6. Only direct: Liberec -> Ceske Budejovice (no diacritics)");
const direct = await call("idos_search_connections", {
    from: "Liberec",
    to: "Ceske Budejovice",
    only_direct: true,
    date,
    time: "06:00",
    count: 3,
    response_format: "json"
});
if (direct.isError) console.log(text(direct));
else {
    const conns = (direct.structuredContent as { connections: { transfers: number; departure: { time: string } }[] }).connections;
    console.log(conns.map(c => `${c.departure.time} transfers=${c.transfers}`).join(" | "));
    check(
        "only direct => 0 transfers",
        conns.every(c => c.transfers === 0)
    );
}

section("7. Ambiguous name 'Nová Ves' and unknown name");
const amb = await call("idos_search_connections", { from: "Nová Ves", to: "Brno", date, time: "08:00" });
console.log(text(amb));
check("ambiguous -> isError with suggestions", amb.isError === true && /okres/.test(text(amb)));
const unknown = await call("idos_search_connections", { from: "Xyzqwvbn", to: "Brno", date, time: "08:00" });
console.log(text(unknown));
check("unknown -> isError", unknown.isError === true);
const district = await call("idos_search_connections", { from: "Nová Ves; okres Brno-venkov", to: "Brno", date, time: "08:00", count: 3 });
console.log(text(district).split("\n").slice(0, 6).join("\n"));
check("explicit district resolves", !district.isError);

section("8. Date outside the timetable period");
const range = await call("idos_search_connections", { from: "Praha", to: "Brno", date: "2028-06-01", time: "08:00" });
console.log(text(range));
check("out of range -> isError", range.isError === true);

section("9. Connection detail (first connection of step 2)");
const detail = await call("idos_get_connection_detail", { connection_id: data.connections[0].connection_id });
console.log(text(detail));
check("detail ok", !detail.isError && /Stops/.test(text(detail)));
const detailJson = await call("idos_get_connection_detail", {
    connection_id: data.connections[0].connection_id,
    include_full_route: true,
    response_format: "json"
});
const dj = detailJson.structuredContent as { distance_km?: number; legs: { stops: { on_leg: boolean }[] }[] };
console.log(
    `detail json: legs=${dj.legs.length}, distance_km=${dj.distance_km}, stops per leg=${dj.legs.map(l => l.stops.length).join(",")}`
);
check(
    "detail json has stops",
    dj.legs.every(l => l.stops.length >= 2)
);

section("10. Bad page_token / connection_id");
const badToken = await call("idos_search_connections", { page_token: "garbage" });
console.log(text(badToken));
check("bad token -> isError", badToken.isError === true);
const badId = await call("idos_get_connection_detail", { connection_id: "https://example.com/x?p=1" });
console.log(text(badId));
check("bad id -> isError", badId.isError === true);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
