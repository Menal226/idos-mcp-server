// idos_get_departures and idos_get_trip_route. IDOS URLs (all GET):
//  - /{timetable}/Ajax/SearchTimetableObjectsDep/   station autocomplete of the board form (JSONP)
//  - /{timetable}/odjezdy/vysledky/?f=&fc=&date=&time=[&byarr=true]   the board (byarr=true: arrivals)
//  - /{timetable}/Ajax/TrainDetail?ttIndex=&train=&absCombId=&dateFrom=&timeFrom=&stationFromName=&isArr=&isDep=true   one trip (JSONP)
// IDOS's own "later departures" button POSTs to Ajax/DepPaging, which this read-only server never does; instead the
// board is re-queried from the last shown departure (see `page_token`).
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
    clean,
    compact,
    dateSchema,
    decodeToken,
    encodeToken,
    errorResult,
    fitToLimit,
    jsonResult,
    largestFittingCount,
    READ_ONLY_ANNOTATIONS,
    ResponseFormat,
    responseFormatSchema,
    textResult,
    timeSchema,
    timetableSchema,
    toIdosDate,
    ToolError,
    toolErrorResult
} from "../common.js";
import { idosGet, idosGetJsonp } from "../http.js";
import {
    type BoardEntry,
    type BoardError,
    type BoardPage,
    parseBoardPage,
    parseTripDetail,
    type TripHandle,
    type TripRoute
} from "../parsers/departures.js";

interface RawDepLocation {
    selectedText: string | null;
    text: string | null;
    description: string | null;
    value: string | null;
}

export interface ResolvedStation {
    name: string;
    /** IDOS object class (`fc`): 100003 railway station, 200003 stop, 301003 city-transport stop, ... */
    objectClass: string;
}

export type StationResolution = { ok: true; station: ResolvedStation } | { ok: false; message: string };

/**
 * Resolves a station name to the exact IDOS name + object class via the board's own autocomplete. A bare name can
 * silently resolve to the wrong place (e.g. "Florenc" -> Florence, Italy).
 */
export async function resolveDepartureStation(query: string, timetable: string, signal?: AbortSignal): Promise<StationResolution> {
    const raw = await idosGetJsonp<RawDepLocation[] | null>(
        `/${timetable}/Ajax/SearchTimetableObjectsDep/`,
        { count: 12, prefixText: query, searchByPosition: false, onlyStation: true, format: "json" },
        { signal }
    );
    const options = (raw ?? [])
        .map(item => ({ name: clean(item.selectedText || item.text), description: clean(item.description), objectClass: item.value ?? "" }))
        .filter(item => item.name);

    if (options.length === 0) {
        return {
            ok: false,
            message: `IDOS knows no station or stop named '${query}'. Check the spelling, or call idos_search_locations with only_stations=true to find the exact name.`
        };
    }
    const wanted = compact(query);
    const chosen =
        options.find(o => compact(o.name) === wanted || compact(o.name.split(";")[0]) === wanted) ??
        (options.length === 1 ? options[0] : undefined);
    if (chosen) return { ok: true, station: { name: chosen.name, objectClass: chosen.objectClass } };

    return {
        ok: false,
        message: [
            `'${query}' is ambiguous. Call idos_get_departures again with one of these exact names as \`station\`:`,
            ...options.map(o => `- ${o.name}${o.description ? ` (${o.description})` : ""}`),
            "Or use idos_search_locations to look further."
        ].join("\n")
    };
}

export async function fetchBoard(
    station: ResolvedStation,
    options: { timetable: string; arrivals: boolean; date?: string; time?: string; signal?: AbortSignal }
): Promise<BoardPage | BoardError> {
    const { body } = await idosGet(
        `/${options.timetable}/odjezdy/vysledky/`,
        {
            date: options.date,
            time: options.time,
            // IDOS's own URL builder trims "; okres" qualifiers from names in the query string.
            f: station.name.replace("; okres", ";").replace("; district", ";").replace("; Kreis", ";"),
            fc: station.objectClass || undefined,
            byarr: options.arrivals ? "true" : undefined
        },
        { signal: options.signal }
    );
    return parseBoardPage(body, options.timetable);
}

interface PageToken {
    v: 1;
    tb: string;
    s: string;
    fc: string;
    a: boolean;
    d: string;
    t: string;
    /** Keys of entries at exactly d/t that were already shown. */
    k: string[];
}

function matchesLine(entry: BoardEntry, filter: string): boolean {
    const wanted = compact(filter);
    const candidates = [
        entry.line,
        entry.number,
        `${entry.category}${entry.number}`,
        entry.train_name,
        entry.service,
        ...entry.service.split(/[\s()]+/)
    ];
    if (candidates.some(c => c && compact(c) === wanted)) return true;
    // Carrier brand, e.g. "Leo Express" or "RegioJet" (trains without a name are otherwise missed).
    return wanted.length >= 4 && entry.carrier !== undefined && compact(entry.carrier).startsWith(wanted);
}

function matchesPlace(entry: BoardEntry, filter: string): boolean {
    const wanted = compact(filter);
    return [entry.destination, ...entry.via].some(name => compact(name).includes(wanted));
}

const minuteOf = (entry: BoardEntry) => entry.datetime.slice(0, 16);

function cursorStamp(date: string, time: string): string {
    const [d, m, y] = date.split(".").map(Number);
    const [hh, mm] = time.split(":").map(Number);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}`;
}

const departuresInput = z.strictObject({
    station: z
        .string()
        .min(2)
        .max(128)
        .optional()
        .describe("Station or stop name, e.g. 'Praha hl.n.', 'Brno hl.n.', 'Florenc'. Required unless page_token is given."),
    direction: z.enum(["departures", "arrivals"]).default("departures").describe("'departures' (default) or 'arrivals'"),
    date: dateSchema,
    time: timeSchema,
    line: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe(
            "Only this line, train or carrier brand, e.g. 'R9', 'S7', 'Ex7', 'IC 500', '207', 'C' (metro C), 'Pendolino', 'Leo Express', 'RegioJet'"
        ),
    destination: z
        .string()
        .min(2)
        .max(80)
        .optional()
        .describe("Only services whose destination (origin, for arrivals) or listed via stops contain this text, e.g. 'Kolín', 'Plzeň'"),
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum entries to return (1-100, default 20)"),
    page_token: z
        .string()
        .max(4000)
        .optional()
        .describe(
            "next_page_token from a previous result, to continue with later entries. Station, direction, date, time and timetable are then taken from the token."
        ),
    timetable: timetableSchema,
    response_format: responseFormatSchema
});

interface DeparturesResult {
    station: string;
    station_type?: string;
    station_region?: string;
    direction: "departures" | "arrivals";
    filters: { line?: string; destination?: string };
    count: number;
    entries: Omit<BoardEntry, "key">[];
    next_page_token?: string;
    scanned_until?: string;
    truncated?: boolean;
}

const MAX_BOARD_REQUESTS = 4;

/** Returns how many entries were found and a builder for the result cut to the first `count`, whose page token continues right after them. */
async function getDepartures(
    q: z.infer<typeof departuresInput>,
    signal: AbortSignal
): Promise<{ found: number; withCount: (count: number) => DeparturesResult }> {
    let timetable = q.timetable;
    let station: ResolvedStation;
    let arrivals = q.direction === "arrivals";
    let date = toIdosDate(q.date);
    let time = q.time;
    let skip = new Set<string>();
    let minStamp: string | undefined;

    if (q.page_token) {
        const token = decodeToken<PageToken>(q.page_token);
        if (!token || token.v !== 1 || !token.s || !token.d || !token.t) {
            throw new ToolError(
                "Invalid page_token. Use the next_page_token value from a previous idos_get_departures result unchanged, or query again with a later `time`."
            );
        }
        ({ tb: timetable, a: arrivals, d: date, t: time } = token);
        station = { name: token.s, objectClass: token.fc };
        skip = new Set(token.k);
        minStamp = cursorStamp(token.d, token.t);
    } else {
        if (!q.station) throw new ToolError("Provide `station` (e.g. 'Praha hl.n.'), or a `page_token` from a previous result.");
        const resolution = await resolveDepartureStation(q.station, timetable, signal);
        if (!resolution.ok) throw new ToolError(resolution.message);
        station = resolution.station;
    }

    const filtered = Boolean(q.line || q.destination);
    const matched: BoardEntry[] = [];
    const seen = new Set<string>();
    let first: BoardPage | undefined;
    let lastSeen: BoardEntry | undefined;
    let exhausted = false;

    for (let request = 0; request < MAX_BOARD_REQUESTS && matched.length < q.limit; request++) {
        const page = await fetchBoard(station, { timetable, arrivals, date, time, signal });
        if ("error" in page) {
            if (first) break; // a later page failed: return what we have
            const detail = page.error ? ` IDOS says: "${page.error}".` : "";
            const validity = page.validity ? ` Timetable data covers ${page.validity.from} to ${page.validity.to}.` : "";
            throw new ToolError(
                `IDOS returned no ${arrivals ? "arrivals" : "departures"} board for '${station.name}'.${detail}${validity} Check the date/time, or use idos_search_locations to verify the station name.`
            );
        }
        first ??= page;

        const fresh = page.entries.filter(e => !seen.has(e.key) && !skip.has(e.key) && (minStamp === undefined || minuteOf(e) >= minStamp));
        if (fresh.length === 0) {
            exhausted = true;
            break;
        }
        for (const entry of fresh) {
            seen.add(entry.key);
            lastSeen = entry;
            if ((!q.line || matchesLine(entry, q.line)) && (!q.destination || matchesPlace(entry, q.destination))) matched.push(entry);
        }
        const last = page.entries[page.entries.length - 1];
        minStamp = minuteOf(last);
        date = last.date;
        time = last.time;
        skip = new Set(page.entries.filter(e => minuteOf(e) === minStamp).map(e => e.key));
    }

    const selected = matched.slice(0, q.limit);

    const tokenFor = (returned: BoardEntry[]): string | undefined => {
        const allMatchesReturned = returned.length >= matched.length;
        if (allMatchesReturned && exhausted) return undefined;
        // Continue right after the last returned match if some remain unreturned, otherwise after everything scanned.
        const anchor = allMatchesReturned ? lastSeen : returned[returned.length - 1];
        if (!anchor) return undefined;
        const passed = allMatchesReturned ? [...seen] : returned.map(e => e.key);
        return encodeToken({
            v: 1,
            tb: timetable,
            s: station.name,
            fc: station.objectClass,
            a: arrivals,
            d: anchor.date,
            t: anchor.time,
            k: passed.filter(key => key.endsWith(`@${minuteOf(anchor)}`))
        } satisfies PageToken);
    };

    const withCount = (count: number): DeparturesResult => {
        const returned = selected.slice(0, count);
        const nextToken = tokenFor(returned);
        return {
            station: first?.station || station.name,
            ...(first?.station_type ? { station_type: first.station_type } : {}),
            ...(first?.station_region ? { station_region: first.station_region } : {}),
            direction: arrivals ? "arrivals" : "departures",
            filters: { ...(q.line ? { line: q.line } : {}), ...(q.destination ? { destination: q.destination } : {}) },
            count: returned.length,
            entries: returned.map(({ key: _key, ...rest }) => rest),
            ...(nextToken ? { next_page_token: nextToken } : {}),
            ...(filtered && matched.length < q.limit && lastSeen ? { scanned_until: `${lastSeen.date} ${lastSeen.time}` } : {}),
            ...(count < selected.length ? { truncated: true } : {})
        };
    };

    return { found: selected.length, withCount };
}

interface RawTrainDetail {
    content: string | null;
    error: string | null;
    hasError: boolean;
}

export async function getTripRoute(tripId: string, signal?: AbortSignal): Promise<TripRoute | { error: string }> {
    const handle = decodeToken<TripHandle>(tripId);
    if (
        !handle ||
        typeof handle.tb !== "string" ||
        !/^[a-z0-9]+$/.test(handle.tb) ||
        typeof handle.n !== "number" ||
        handle.n < 0 ||
        typeof handle.i !== "number"
    ) {
        return { error: "Invalid trip_id. Copy the trip_id of an entry returned by idos_get_departures unchanged." };
    }
    const raw = await idosGetJsonp<RawTrainDetail>(
        `/${handle.tb}/Ajax/TrainDetail`,
        {
            ttIndex: handle.i,
            train: handle.n,
            absCombId: handle.c,
            dateFrom: handle.d,
            timeFrom: handle.t,
            stationFromName: handle.s,
            isArr: handle.a,
            isDep: true
        },
        { signal }
    );
    if (raw.hasError || !raw.content?.includes("line-itinerary")) {
        return {
            error: `IDOS could not show this trip${raw.error ? `: ${clean(raw.error)}` : ""}. The trip_id may be from an old board; call idos_get_departures again and use a fresh trip_id.`
        };
    }
    return parseTripDetail(raw.content, handle.s);
}

function realtimeSummary(entry: Omit<BoardEntry, "key">): string | undefined {
    const text = entry.realtime ?? "";
    const minutes = entry.delay_minutes;
    if (/^Aktuální zpoždění/i.test(text) && minutes !== undefined) return `**+${minutes} min** (live)`;
    if (/^Předpokládané zpoždění/i.test(text) && minutes !== undefined) return `+${minutes} min expected`;
    if (/^Aktuálně bez zpoždění/i.test(text)) return "on time (live)";
    if (/^Nepředpokládá se zpoždění/i.test(text)) return "no delay expected";
    if (text) return text;
    if (minutes !== undefined && minutes > 0) return `+${minutes} min`;
    return undefined;
}

function renderBoard(result: DeparturesResult): string {
    const arrivals = result.direction === "arrivals";
    const where = [result.station_type, result.station_region].filter(Boolean).join(", ");
    const lines = [`# ${arrivals ? "Arrivals at" : "Departures from"} ${result.station}${where ? ` (${where})` : ""}`];
    const filters = [
        result.filters.line ? `line ${result.filters.line}` : "",
        result.filters.destination ? `${arrivals ? "from/via" : "to/via"} ${result.filters.destination}` : ""
    ].filter(Boolean);
    if (filters.length) lines.push(`Filtered: ${filters.join(", ")}`);
    if (result.entries.length === 0) {
        lines.push(
            "",
            `No matching ${arrivals ? "arrivals" : "departures"} found${result.scanned_until ? ` (searched until ${result.scanned_until})` : ""}.`
        );
    }

    let currentDate = "";
    for (const e of result.entries) {
        if (e.date !== currentDate) {
            currentDate = e.date;
            lines.push("", `## ${e.date}`);
        }
        const head = [
            `**${e.time}**`,
            e.service,
            `${arrivals ? "from" : "→"} **${e.destination}**`,
            e.platform ? `platform ${e.platform}` : "",
            e.track ? `track ${e.track}` : "",
            realtimeSummary(e) ?? ""
        ].filter(Boolean);
        lines.push(`- ${head.join(" · ")}`);
        const detail = [e.via.length ? `via ${e.via.join(", ")}` : "", e.carrier ?? "", e.notes.join("; ")].filter(Boolean);
        if (detail.length) lines.push(`  ${detail.join(" · ")}`);
        lines.push(`  trip_id: \`${e.trip_id}\``);
    }

    lines.push("");
    if (result.truncated) {
        lines.push(
            `Showing ${result.entries.length} entries to stay within the response size limit; the page token below continues after them.`
        );
    }
    if (result.next_page_token) lines.push(`More: call idos_get_departures with page_token=\`${result.next_page_token}\``);
    lines.push("Use idos_get_trip_route with a trip_id to see all stops of that trip.");
    return lines.join("\n");
}

export function renderTripRoute(route: TripRoute): string {
    const lines = [`# ${route.service}${route.category_name ? ` (${route.category_name})` : ""}`];
    if (route.start_date) lines.push(`Departs first stop on ${route.start_date}.`);
    if (route.current_position) lines.push(`Live position: ${route.current_position} (last passed stop: ${route.position_after_stop}).`);
    lines.push("", "| # | Stop | Arr | Dep | Platform | km | Notes |", "|---|---|---|---|---|---|---|");
    route.stops.forEach((s, index) => {
        const name = s.selected_station ? `**► ${s.name}**` : s.name;
        const notes = [s.tariff_zone ? `zone ${s.tariff_zone}` : "", ...s.notes].filter(Boolean).join("; ");
        lines.push(
            `| ${index + 1} | ${name} | ${s.arrival ?? ""} | ${s.departure ?? ""} | ${s.platform ?? ""} | ${s.distance_km ?? ""} | ${notes.replace(/\|/g, "/")} |`
        );
    });
    if (route.remarks.length) lines.push("", "## Remarks", ...route.remarks.map(r => `- ${r}`));
    if (route.web_url) lines.push("", `IDOS page: ${route.web_url}`);
    return lines.join("\n");
}

export function registerDepartureTools(server: McpServer): void {
    server.registerTool(
        "idos_get_departures",
        {
            title: "Station departures / arrivals board",
            description: `Departure or arrival board for one IDOS station or stop (trains, buses, trams, metro), with platforms, carriers and live delays.

The station must be a concrete station/stop, not a whole town: 'Praha hl.n.', 'Brno hl.n.', 'Brno,,ÚAN Zvonařka', 'Florenc' (Prague metro/bus). If the name is ambiguous the error lists exact names to retry with (or use idos_search_locations with only_stations=true).

Examples:
  - "Next trains from Prague main station" -> station="Praha hl.n."
  - "Arrivals at Brno tomorrow at 8" -> station="Brno hl.n.", direction="arrivals", date="2026-11-07", time="08:00"
  - "When is the next R9 from Praha hl.n.?" -> station="Praha hl.n.", line="R9"
  - "Buses from ÚAN Zvonařka to Kyjov" -> station="Brno,,ÚAN Zvonařka", destination="Kyjov"
  - More results -> pass next_page_token from the previous result as page_token.

Each entry has time, service (line/train type, number, name), destination (origin for arrivals), "via" stops, platform, carrier, real-time delay when known, and a trip_id for idos_get_trip_route (all stops of that trip).
Line and destination filters are applied by this server (IDOS has none); up to ~4 board pages are scanned per call.`,
            inputSchema: departuresInput,
            annotations: READ_ONLY_ANNOTATIONS
        },
        async (args, ctx) => {
            try {
                const result = await getDepartures(args, ctx.mcpReq.signal);
                const json = args.response_format === ResponseFormat.JSON;
                const render = (r: DeparturesResult) => (json ? JSON.stringify(r, null, 2) : renderBoard(r));
                const final = result.withCount(largestFittingCount(result.found, n => render(result.withCount(n))));
                return json ? jsonResult({ ...final }) : textResult(renderBoard(final));
            } catch (error) {
                return toolErrorResult(error);
            }
        }
    );

    server.registerTool(
        "idos_get_trip_route",
        {
            title: "All stops of one trip",
            description: `Full route of one train/bus/tram trip from a departures board: every stop with arrival and departure times, platform at the selected station, tariff zones, distance, live position when known, and remarks (on-board services, carrier).

Input is a trip_id from idos_get_departures (it identifies the trip on that date). The station you queried is marked as selected; stops before it are flagged before_selected_station.

Example: "Which stops does the 20:31 Pendolino from Praha make?" -> call idos_get_departures(station="Praha hl.n.", line="Pendolino"), then idos_get_trip_route(trip_id=<entry.trip_id>).`,
            inputSchema: z.strictObject({
                trip_id: z.string().min(10).max(2000).describe("trip_id of an entry returned by idos_get_departures"),
                response_format: responseFormatSchema
            }),
            annotations: READ_ONLY_ANNOTATIONS
        },
        async ({ trip_id, response_format }, ctx) => {
            try {
                const route = await getTripRoute(trip_id, ctx.mcpReq.signal);
                if ("error" in route) return errorResult(route.error);
                if (response_format === ResponseFormat.JSON) return jsonResult({ ...route });
                return textResult(fitToLimit(route.stops, stops => renderTripRoute({ ...route, stops })).text);
            } catch (error) {
                return toolErrorResult(error);
            }
        }
    );
}
