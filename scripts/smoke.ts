/**
 * End-to-end self-check: starts the BUILT server over stdio like an MCP host would, lists its tools, verifies every
 * tool is annotated read-only, calls each one against the live IDOS site, and exits non-zero on any failure.
 * Run with: npm run build && npm run smoke
 */
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildIdosUrl } from "../src/http.js";

const EXPECTED_TOOLS = [
    "idos_get_connection_detail",
    "idos_get_departures",
    "idos_get_line_route",
    "idos_get_stop_timetable",
    "idos_get_train_route",
    "idos_get_trip_route",
    "idos_list_city_timetables",
    "idos_search_connections",
    "idos_search_lines",
    "idos_search_locations"
];

/** Tomorrow in Prague as YYYY-MM-DD, so searches are never in the past. */
const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date(Date.now() + 86_400_000));

// 0. The read-only guard refuses purchase/account pages and other hosts before any request is made
for (const blocked of [
    "/vlakyautobusymhdvse/jizdenky/",
    "/vlakyautobusymhdvse/spojeni/mojespojeni/?h=0",
    "/Account/Login",
    "/vlakyautobusymhdvse/kosik/",
    "https://example.com/vlakyautobusymhdvse/spojeni/"
]) {
    assert.throws(() => buildIdosUrl(blocked), `guard should refuse ${blocked}`);
}
assert.doesNotThrow(() => buildIdosUrl("/vlakyautobusymhdvse/spojeni/vysledky/"));
console.error("PASS read-only URL guard");

const client = new Client({ name: "idos-smoke-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["build/index.js"], env: getDefaultEnvironment() }));

type Result = Awaited<ReturnType<typeof client.callTool>>;
const textOf = (r: Result) => (r.content as { type: string; text?: string }[]).map(c => c.text ?? "").join("\n");

async function call(name: string, args: Record<string, unknown>, expectError = false): Promise<Result> {
    const started = Date.now();
    const result = await client.callTool({ name, arguments: args });
    const text = textOf(result);
    if (expectError) assert.equal(result.isError, true, `${name} should have failed: ${text.slice(0, 300)}`);
    else assert.ok(!result.isError, `${name} failed: ${text.slice(0, 500)}`);
    assert.ok(text.length <= 25_000, `${name} response exceeds the character limit (${text.length})`);
    console.error(`PASS ${name}${expectError ? " (expected error)" : ""} — ${Date.now() - started} ms, ${text.length} chars`);
    return result;
}

// 1. Tool list and read-only annotations
const { tools } = await client.listTools();
assert.deepEqual(tools.map(t => t.name).sort(), EXPECTED_TOOLS);
for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be readOnlyHint`);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must not be destructive`);
}
console.error(`PASS ${tools.length} tools listed, all read-only`);

// 2. Locations
await call("idos_search_locations", { query: "Brno hl" });

// 3. Connections + detail
const conns = await call("idos_search_connections", {
    from: "Praha",
    to: "Brno",
    date: tomorrow,
    time: "08:00",
    count: 3,
    response_format: "json"
});
const connectionId = (conns.structuredContent as { connections: { connection_id: string }[] }).connections[0]?.connection_id;
assert.ok(connectionId, "search returned no connection_id");
await call("idos_get_connection_detail", { connection_id: connectionId });

// 4. Departures + trip route
const board = await call("idos_get_departures", {
    station: "Praha hl.n.",
    date: tomorrow,
    time: "09:00",
    limit: 5,
    response_format: "json"
});
const tripId = (board.structuredContent as { entries: { trip_id: string }[] }).entries[0]?.trip_id;
assert.ok(tripId, "board returned no trip_id");
await call("idos_get_trip_route", { trip_id: tripId });

// 5. City lines (ZJŘ)
await call("idos_list_city_timetables", {});
await call("idos_search_lines", { city: "Praha", query: "136" });
await call("idos_get_line_route", { city: "Praha", line: "136" });
await call("idos_get_stop_timetable", { city: "Brno", line: "1", stop: "Hlavní nádraží", date: tomorrow });

// 6. Train by number: take a real train from the board so the check doesn't depend on a fixed timetable
const trains = await call("idos_get_departures", {
    station: "Praha hl.n.",
    date: tomorrow,
    time: "10:00",
    limit: 10,
    timetable: "vlaky",
    response_format: "json"
});
const train = (trains.structuredContent as { entries: { category: string; number: string; time: string }[] }).entries[0];
assert.ok(train, "no train on the board");
await call("idos_get_train_route", {
    train: `${train.category} ${train.number}`,
    station: "Praha hl.n.",
    date: tomorrow,
    time: train.time
});

// 7. Errors the model can read and recover from
await call("idos_search_locations", { query: "B" }, true); // input validation
await call("idos_get_departures", { station: "Xyzzyqqq" }, true); // unknown station
await call("idos_get_trip_route", { trip_id: "not-a-real-trip-id" }, true);

await client.close();
console.error("Smoke test passed");
