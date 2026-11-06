// Live check of the departures tools against idos.cz: npx tsx scripts/check-departures.ts
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { registerDepartureTools } from "../src/tools/departures.js";

type Handler = (args: unknown, ctx: unknown) => Promise<CallToolResult>;
interface Registered {
    schema: { parse: (input: unknown) => unknown };
    handler: Handler;
}

const tools = new Map<string, Registered>();
const fakeServer = {
    registerTool(name: string, config: { inputSchema: Registered["schema"] }, handler: Handler) {
        tools.set(name, { schema: config.inputSchema, handler });
    }
} as unknown as McpServer;
registerDepartureTools(fakeServer);

async function call(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    const args = tool.schema.parse(input);
    return tool.handler(args, { mcpReq: { signal: AbortSignal.timeout(60_000) } });
}

function text(result: CallToolResult): string {
    return result.content.map(c => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

function show(title: string, result: CallToolResult, maxChars = 2500): void {
    const body = text(result);
    console.log(`\n=== ${title}${result.isError ? "  [isError]" : ""} (${body.length} chars)`);
    console.log(body.length > maxChars ? `${body.slice(0, maxChars)}\n... (truncated for display)` : body);
}

function tomorrow(): string {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

let failures = 0;
function expect(condition: boolean, message: string): void {
    if (!condition) failures++;
    console.log(condition ? `  ok: ${message}` : `  !! FAILED: ${message}`);
}

// 1. Departures from Praha hl.n. now (markdown)
const praha = await call("idos_get_departures", { station: "Praha hl.n.", limit: 8 });
show("Departures from Praha hl.n. now (markdown, limit 8)", praha);
expect(!praha.isError && text(praha).includes("trip_id"), "Praha board has entries with trip_id");

// 2. Same, JSON, then page 2 via page_token, then trip route of the first entry
const prahaJson = await call("idos_get_departures", { station: "praha hl n", limit: 5, response_format: "json" });
interface Board {
    station: string;
    entries: { time: string; date: string; datetime: string; service: string; destination: string; trip_id: string; platform?: string }[];
    next_page_token?: string;
    scanned_until?: string;
    truncated?: boolean;
}
const p1 = prahaJson.structuredContent as unknown as Board;
console.log(
    "\n=== JSON page 1 (input 'praha hl n'):",
    p1.station,
    p1.entries.map(e => `${e.time} ${e.service} -> ${e.destination} [${e.platform ?? "-"}]`)
);
console.log("first entry JSON:", JSON.stringify(p1.entries[0], null, 1).slice(0, 1500));
expect(p1.entries.length === 5 && Boolean(p1.next_page_token), "JSON page 1 has 5 entries and a next_page_token");

const page2 = await call("idos_get_departures", { page_token: p1.next_page_token, limit: 5, response_format: "json" });
const p2 = page2.structuredContent as unknown as Board;
console.log(
    "=== JSON page 2:",
    p2.entries.map(e => `${e.date} ${e.time} ${e.service} -> ${e.destination}`)
);
const ids1 = new Set(p1.entries.map(e => e.trip_id));
expect(p2.entries.length > 0 && p2.entries.every(e => !ids1.has(e.trip_id)), "page 2 continues without duplicates");
expect(p2.entries[0].datetime >= p1.entries[4].datetime, "page 2 starts at/after the end of page 1");

const route = await call("idos_get_trip_route", { trip_id: p1.entries[1].trip_id });
show(`Trip route of ${p1.entries[1].service} (${p1.entries[1].time})`, route, 3000);
expect(!route.isError && text(route).includes("►"), "route marks the selected station");

// 3. Arrivals at Brno hl.n. tomorrow 08:00, line filter
const brno = await call("idos_get_departures", {
    station: "Brno hl.n.",
    direction: "arrivals",
    date: tomorrow(),
    time: "08:00",
    limit: 6
});
show("Arrivals at Brno hl.n. tomorrow 08:00", brno);
expect(!brno.isError && text(brno).startsWith("# Arrivals at Brno hl.n."), "Brno arrivals board");
expect(text(brno).includes("S41 (Os 4461)") || text(brno).includes(") · from"), "arrival rows carry the IDOS service label");
const brnoJson = await call("idos_get_departures", {
    station: "Brno hl.n.",
    direction: "arrivals",
    date: tomorrow(),
    time: "08:00",
    limit: 2,
    response_format: "json"
});
const bj = brnoJson.structuredContent as unknown as Board;
const arrRoute = await call("idos_get_trip_route", { trip_id: bj.entries[0].trip_id, response_format: "json" });
const ar = arrRoute.structuredContent as { service: string; stops: { name: string; arrival?: string; selected_station: boolean }[] };
console.log(
    "arrival trip route:",
    arrRoute.isError
        ? text(arrRoute)
        : `${ar.service}: ${ar.stops.map(s => `${s.selected_station ? "*" : ""}${s.name} ${s.arrival ?? ""}`).join(" | ")}`
);
expect(
    !arrRoute.isError && ar.stops.some(s => s.selected_station && s.name === "Brno hl.n."),
    "route from an arrivals entry marks Brno hl.n."
);

// 4. Bus stop with destination filter, then the route of a matching bus
const zvonarka = await call("idos_get_departures", {
    station: "Brno,,ÚAN Zvonařka",
    destination: "Kyjov",
    limit: 3,
    response_format: "json"
});
const zv = zvonarka.structuredContent as unknown as Board;
console.log(
    "\n=== Brno,,ÚAN Zvonařka -> Kyjov:",
    zvonarka.isError ? text(zvonarka) : zv.entries.map(e => `${e.date} ${e.time} ${e.service} -> ${e.destination}`),
    zv?.scanned_until ?? ""
);
if (!zvonarka.isError && zv.entries.length) {
    const busRoute = await call("idos_get_trip_route", { trip_id: zv.entries[0].trip_id, response_format: "json" });
    const br = busRoute.structuredContent as {
        service: string;
        stops: { name: string; arrival?: string; departure?: string; selected_station: boolean }[];
    };
    console.log(
        "bus route:",
        br.service,
        br.stops.map(s => `${s.selected_station ? "*" : ""}${s.name} ${s.arrival ?? ""}/${s.departure ?? ""}`).join(" | ")
    );
    expect(br.stops.length > 2, "bus route has stops");
}

// 5. Prague city stop (metro/bus), line filter on metro C
const florenc = await call("idos_get_departures", { station: "Florenc", line: "C", limit: 4 });
show("Florenc (Prague), line C", florenc, 1500);
expect(
    !florenc.isError && text(florenc).includes("Departures from Florenc") && text(florenc).includes("Metro C"),
    "Florenc resolves to Prague (not Florence) and line C filter works"
);

// 6. Ambiguous and unknown names
const ambiguous = await call("idos_get_departures", { station: "Brno" });
show("Ambiguous 'Brno'", ambiguous, 1500);
expect(Boolean(ambiguous.isError) && text(ambiguous).includes("Brno hl.n."), "ambiguous name lists suggestions");

const unknown = await call("idos_get_departures", { station: "Xyzzyqqv" });
show("Unknown name", unknown);
expect(Boolean(unknown.isError), "unknown name is an error");

// 7. Large limit: output must stay under the 25k character limit and the token must continue after the last shown entry
const big = await call("idos_get_departures", { station: "Praha hl.n.", limit: 100, response_format: "json" });
const bg = big.structuredContent as unknown as Board;
const bigText = text(big);
console.log(`\n=== limit=100 JSON: ${bg.entries.length} entries, ${bigText.length} chars, truncated=${bg.truncated ?? false}`);
expect(bigText.length <= 25_000, "large result fits CHARACTER_LIMIT");
if (bg.next_page_token) {
    const after = await call("idos_get_departures", { page_token: bg.next_page_token, limit: 3, response_format: "json" });
    const af = after.structuredContent as unknown as Board;
    const lastShown = bg.entries[bg.entries.length - 1];
    console.log(`last shown ${lastShown.date} ${lastShown.time}; next page starts ${af.entries[0]?.date} ${af.entries[0]?.time}`);
    expect(
        af.entries.length > 0 && af.entries[0].datetime >= lastShown.datetime && !bg.entries.some(e => e.trip_id === af.entries[0].trip_id),
        "token continues right after the last shown entry"
    );
}

// 8. Bad handles
const badTrip = await call("idos_get_trip_route", { trip_id: "not-a-real-trip-id" });
show("Bad trip_id", badTrip);
expect(Boolean(badTrip.isError), "bad trip_id is an error");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
