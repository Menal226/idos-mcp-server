/**
 * idos_search_connections and idos_get_connection_detail ("spojení"). IDOS URLs used (plain GETs):
 *   /{timetable}/spojeni/vysledky/?f=..&fc=..&t=..&tc=..&date=D.M.YYYY&time=H:MM[&arr=true][&direct=true]
 *       [&af=true&v=a;b&vc=1;1&mch=N]   v/vc/mch are ignored by IDOS unless af=true
 *   /{timetable}/spojeni/prehled/?p=<connection_id>   one connection (permalink)
 *   /{timetable}/spojeni/draha/?p=..                   full stop list of one leg's vehicle
 * fc/tc/vc are IDOS object classes (the autocomplete "value"): 1 municipality, 2 part of town, 100003 station,
 * 200003 stop, 8 address, ...
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
    clean,
    dateSchema,
    decodeToken,
    encodeToken,
    fitToLimit,
    fold,
    jsonResult,
    READ_ONLY_ANNOTATIONS,
    ResponseFormat,
    responseFormatSchema,
    textResult,
    timeSchema,
    timetableSchema,
    todayInPrague,
    toIdosDate,
    ToolError,
    toolErrorResult
} from "../common.js";
import { CHARACTER_LIMIT, DEFAULT_TIMETABLE } from "../constants.js";
import { idosGet, IdosError } from "../http.js";
import {
    type Connection,
    type Leg,
    type LegRoute,
    parseLegRoute,
    parseResultsPage,
    type ResultsPage,
    type RouteStop,
    tokenFromPermalink
} from "../parsers/connections.js";
import { type Location, searchLocations } from "./locations.js";

interface Place {
    name: string;
    cls: string;
    kind?: string;
}

const normalizeName = (text: string) => fold(text).replace(/;\s*okres\s+/g, "; ");

function suggestionList(locations: Location[]): string {
    return locations
        .map(loc => `  - "${loc.name}" (${[loc.kind, loc.region, loc.modes.join(", ")].filter(Boolean).join(", ")})`)
        .join("\n");
}

// Names are always resolved through the autocomplete first: given a name without a class, IDOS silently
// fuzzy-matches it on its own (e.g. "Nová Ves" became "Devínska N.Ves").
async function resolvePlace(input: string, role: "from" | "to" | "via", timetable: string, signal?: AbortSignal): Promise<Place> {
    const query = clean(input);
    const candidates = await searchLocations(query, { timetable, limit: 12, signal });
    const toPlace = (loc: Location): Place => ({ name: loc.name, cls: loc.object_class || "1", kind: loc.kind });

    if (candidates.length === 0) {
        throw new ToolError(
            `IDOS does not know any place called '${query}' (${role}). Check the spelling, or call idos_search_locations with a shorter prefix (e.g. query='${query.slice(0, Math.max(3, Math.ceil(query.length / 2)))}') and pass one of the returned names.`
        );
    }

    const wanted = normalizeName(query);
    const exact = candidates.find(loc => normalizeName(loc.name) === wanted);
    if (exact) return toPlace(exact);

    const sameBase = candidates.filter(loc => normalizeName(loc.name.split(";")[0]) === wanted);
    if (sameBase.length === 1) return toPlace(sameBase[0]);
    if (sameBase.length > 1) {
        throw new ToolError(
            `'${query}' (${role}) is ambiguous: IDOS has several places with that name. Repeat the search with one of these exact names:\n${suggestionList(sameBase)}\n(More may exist: call idos_search_locations with query='${query}' and limit=50.)`
        );
    }

    if (candidates.length === 1) return toPlace(candidates[0]);
    const prefixed = candidates.filter(loc => normalizeName(loc.name).startsWith(wanted));
    if (prefixed.length === 1) return toPlace(prefixed[0]);

    throw new ToolError(
        `'${query}' (${role}) does not exactly match an IDOS place. Did you mean one of these? Repeat the search with the exact name:\n${suggestionList(candidates.slice(0, 8))}`
    );
}

interface SearchState {
    tt: string;
    f: Place;
    t: Place;
    v: Place[];
    direct: boolean;
    mch?: number;
}

// IDOS's own earlier/later paging is POST-only, so we page by re-searching: "later" = departures from the last
// shown departure, "earlier" = arrivals up to the first shown arrival. `seen` holds signatures of connections
// already shown at exactly `at` (ISO local datetime) so they are not repeated.
interface PageToken {
    s: SearchState;
    m: "later" | "earlier";
    at: string;
    seen: string[];
}

interface SearchAt {
    date?: string;
    time?: string;
    arr: boolean;
}

function decodePageToken(raw: string): PageToken {
    const token = decodeToken<PageToken>(raw);
    if (
        token?.s?.f?.name &&
        token.s.t?.name &&
        Array.isArray(token.s.v) &&
        Array.isArray(token.seen) &&
        /^[a-z0-9]+$/.test(token.s.tt) &&
        (token.m === "later" || token.m === "earlier") &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(token.at)
    ) {
        return token;
    }
    throw new ToolError(
        "page_token is not valid. Pass next_page_token / prev_page_token exactly as returned by idos_search_connections, or start a new search with from/to."
    );
}

/** Short stable hash of a connection, to skip duplicates across re-searches. */
function signature(conn: Connection): string {
    const text = `${conn.departure.datetime}|${conn.arrival.datetime}|${conn.legs.map(l => l.name).join(",")}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

const pragueToday = () => new Date(`${todayInPrague()}T00:00:00Z`);

function idosDateToDate(idosDate: string): Date | undefined {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(idosDate);
    return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) : undefined;
}

function isoToIdos(iso: string): { date: string; time: string } {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(iso)!;
    return { date: `${Number(m[3])}.${Number(m[2])}.${m[1]}`, time: `${Number(m[4])}:${m[5]}` };
}

function shiftIso(iso: string, minutes: number): string {
    return new Date(Date.parse(`${iso}:00Z`) + minutes * 60_000).toISOString().slice(0, 16);
}

const lastDeparture = (conns: Connection[]) =>
    conns
        .map(c => c.departure.datetime)
        .sort()
        .at(-1)!;
const firstArrival = (conns: Connection[]) => conns.map(c => c.arrival.datetime).sort()[0];

function searchParams(state: SearchState, at: SearchAt): Record<string, string | undefined> {
    const placeName = (place: Place) => place.name.replace(/;\s*okres\s+/, "; ");
    const params: Record<string, string | undefined> = {
        f: placeName(state.f),
        fc: state.f.cls,
        t: placeName(state.t),
        tc: state.t.cls,
        date: at.date,
        time: at.time
    };
    if (at.arr) params.arr = "true";
    if (state.direct) params.direct = "true";
    if (state.v.length > 0) {
        params.v = state.v.map(p => placeName(p).replace(/;/g, "@")).join(";");
        params.vc = state.v.map(p => p.cls).join(";");
    }
    if (!state.direct && state.mch !== undefined) params.mch = String(state.mch);
    if (params.v || params.mch) params.af = "true";
    return params;
}

function failOnEmptyPage(page: ResultsPage, state: SearchState, query: string): void {
    if (page.fieldErrors.length > 0) {
        const names: Record<string, string> = { from: state.f.name, to: state.t.name, via: state.v.map(v => v.name).join(", ") };
        const detail = page.fieldErrors.map(e => `${e.field} '${names[e.field]}': ${e.message}`).join("; ");
        throw new ToolError(`IDOS rejected a place name (${detail}). Call idos_search_locations to find the exact name and retry.`);
    }
    if (page.connections.length > 0) return;
    const range = page.validity ? ` Timetables currently cover ${page.validity.from} – ${page.validity.to}.` : "";
    const hints = [
        state.direct ? "drop only_direct" : "",
        state.mch !== undefined ? "raise max_changes" : "",
        state.v.length ? "remove 'via'" : "",
        "try another date/time",
        state.tt !== DEFAULT_TIMETABLE ? `use timetable='${DEFAULT_TIMETABLE}'` : ""
    ].filter(Boolean);
    throw new ToolError(
        clean(
            `No connection found from '${state.f.name}' to '${state.t.name}' ${query}. ${page.noResultMessage ?? ""}${range} Suggestions: ${hints.join(", ")}.`
        )
    );
}

const searchInput = z.strictObject({
    from: z
        .string()
        .min(2)
        .max(128)
        .optional()
        .describe(
            "Origin: town, station or stop, e.g. 'Praha', 'Praha hl.n.', 'Brno,,Mendlovo náměstí'. Required unless page_token is given."
        ),
    to: z
        .string()
        .min(2)
        .max(128)
        .optional()
        .describe("Destination, same format as 'from', e.g. 'Brno', 'Ostrava hl.n.'. Required unless page_token is given."),
    via: z
        .array(z.string().min(2).max(128))
        .max(3)
        .optional()
        .describe("Optional places the journey must pass through (max 3), e.g. ['Jihlava']"),
    date: dateSchema,
    time: timeSchema,
    arrival: z
        .boolean()
        .default(false)
        .describe("false (default): 'time' is the earliest departure. true: 'time' is the latest arrival ('arrive by')."),
    only_direct: z.boolean().default(false).describe("true to return only direct connections without transfers"),
    max_changes: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Maximum number of transfers (0-10; IDOS default is 4). 0 is the same as only_direct=true."),
    count: z
        .number()
        .int()
        .min(1)
        .max(15)
        .default(5)
        .describe("How many connections to return (1-15, default 5). Each 3 connections cost one IDOS request."),
    page_token: z
        .string()
        .max(4000)
        .optional()
        .describe(
            "next_page_token or prev_page_token from a previous result to get later / earlier connections of the same search. When given, from/to/via/date/time/arrival/only_direct/max_changes/timetable are taken from the token."
        ),
    timetable: timetableSchema,
    response_format: responseFormatSchema
});

interface SearchResult {
    from: string;
    to: string;
    via?: string[];
    query: string;
    timetable: string;
    count: number;
    connections: Connection[];
    next_page_token?: string;
    prev_page_token?: string;
    idos_url: string;
}

const MAX_FETCHES = 5;

async function searchConnections(args: z.infer<typeof searchInput>, signal?: AbortSignal): Promise<SearchResult> {
    const { count } = args;
    const seen = new Set<string>();
    let state: SearchState;
    let start: SearchAt;
    let query: string;

    if (args.page_token) {
        const token = decodePageToken(args.page_token);
        state = token.s;
        start = { ...isoToIdos(token.at), arr: token.m === "earlier" };
        token.seen.forEach(sig => seen.add(sig));
        query = start.arr
            ? `arriving by ${start.time} on ${start.date} (earlier page)`
            : `departing from ${start.time} on ${start.date} (later page)`;
    } else {
        if (!args.from || !args.to) {
            throw new ToolError("Provide both 'from' and 'to' (or a page_token from a previous idos_search_connections result).");
        }
        const { timetable } = args;
        const from = await resolvePlace(args.from, "from", timetable, signal);
        const to = await resolvePlace(args.to, "to", timetable, signal);
        const via: Place[] = [];
        for (const v of args.via ?? []) via.push(await resolvePlace(v, "via", timetable, signal));
        state = {
            tt: timetable,
            f: from,
            t: to,
            v: via,
            direct: args.only_direct || args.max_changes === 0,
            ...(args.max_changes ? { mch: args.max_changes } : {})
        };
        const time = args.time?.replace(/^0(\d):/, "$1:");
        const date = toIdosDate(args.date) ?? (time ? toIdosDate(todayInPrague()) : undefined);
        start = { date, time, arr: args.arrival };
        const when = time || date ? `${time ?? ""}${time && date ? " on " : ""}${date ?? ""}` : "now";
        query = args.arrival ? `arriving by ${when}` : `departing from ${when}`;
    }
    const reference = (start.date && idosDateToDate(start.date)) || pragueToday();

    const collected: Connection[] = [];
    let cursor = start;
    let firstUrl = "";
    for (let i = 0; i < Math.min(MAX_FETCHES, Math.ceil(count / 3) + 1); i++) {
        const { body, url } = await idosGet(`/${state.tt}/spojeni/vysledky/`, searchParams(state, cursor), { signal });
        const page = parseResultsPage(body, reference);
        if (i === 0) {
            firstUrl = url;
            failOnEmptyPage(page, state, query);
        }
        const fresh = page.connections.filter(conn => !seen.has(signature(conn)));
        for (const conn of fresh) {
            seen.add(signature(conn));
            collected.push(conn);
        }
        if (collected.length >= count || page.connections.length === 0) break;

        // A page of only duplicates would repeat forever, so move the anchor by a minute.
        const anchor = start.arr ? firstArrival(page.connections) : lastDeparture(page.connections);
        cursor = { ...isoToIdos(fresh.length > 0 ? anchor : shiftIso(anchor, start.arr ? -1 : 1)), arr: start.arr };
    }

    const byDeparture = (a: Connection, b: Connection) => a.departure.datetime.localeCompare(b.departure.datetime);
    const shown = start.arr
        ? collected
              .sort((a, b) => a.arrival.datetime.localeCompare(b.arrival.datetime))
              .slice(-count)
              .sort(byDeparture)
        : collected.sort(byDeparture).slice(0, count);

    const paging: Pick<SearchResult, "next_page_token" | "prev_page_token"> = {};
    if (shown.length > 0) {
        const lastDep = lastDeparture(shown);
        const firstArr = firstArrival(shown);
        paging.next_page_token = encodeToken({
            s: state,
            m: "later",
            at: lastDep,
            seen: shown.filter(c => c.departure.datetime === lastDep).map(signature)
        } satisfies PageToken);
        paging.prev_page_token = encodeToken({
            s: state,
            m: "earlier",
            at: firstArr,
            seen: shown.filter(c => c.arrival.datetime === firstArr).map(signature)
        } satisfies PageToken);
    }

    return {
        from: state.f.name,
        to: state.t.name,
        ...(state.v.length ? { via: state.v.map(v => v.name) } : {}),
        query,
        timetable: state.tt,
        count: shown.length,
        connections: shown,
        ...paging,
        idos_url: firstUrl
    };
}

interface LegDetail extends Omit<Leg, "route_url"> {
    distance_km?: number;
    stops: RouteStop[];
    remarks: string[];
}

interface ConnectionDetail extends Omit<Connection, "legs"> {
    distance_km?: number;
    legs: LegDetail[];
}

function parseConnectionId(raw: string, timetable: string): { token: string; timetable: string } {
    const text = raw.trim();
    if (/^https?:\/\//i.test(text) || text.startsWith("/")) {
        const url = new URL(text, "https://idos.cz");
        const token = tokenFromPermalink(url.href);
        const segment = url.pathname.split("/").filter(Boolean)[0];
        if (!token || !/\/spojeni\/prehled\/?$/.test(url.pathname)) {
            throw new ToolError(
                "connection_id must be the connection_id returned by idos_search_connections (or an https://idos.cz/.../spojeni/prehled/?p=... link)."
            );
        }
        return { token, timetable: segment && /^[a-z0-9]+$/.test(segment) && segment !== "en" && segment !== "de" ? segment : timetable };
    }
    if (!/^[A-Za-z0-9.:_-]+$/.test(text)) {
        throw new ToolError("connection_id has unexpected characters. Pass it exactly as returned by idos_search_connections.");
    }
    return { token: text, timetable };
}

async function getConnectionDetail(
    connectionId: string,
    options: { timetable: string; includeFullRoute: boolean; signal?: AbortSignal }
): Promise<ConnectionDetail> {
    const { token, timetable } = parseConnectionId(connectionId, options.timetable);
    const { body } = await idosGet(`/${timetable}/spojeni/prehled/`, { p: token }, { signal: options.signal });
    const conn = parseResultsPage(body, pragueToday()).connections[0];
    if (!conn) {
        throw new ToolError(
            "IDOS did not return this connection (the id may be malformed or expired after a timetable change). Run idos_search_connections again and use a fresh connection_id."
        );
    }

    const legs: LegDetail[] = [];
    for (const { route_url, ...leg } of conn.legs) {
        let route: LegRoute | undefined;
        if (route_url) {
            try {
                route = parseLegRoute((await idosGet(route_url, {}, { signal: options.signal })).body);
            } catch (error) {
                if (!(error instanceof IdosError)) throw error;
            }
        }
        const stops = route
            ? route.stops.filter(s => options.includeFullRoute || s.on_leg)
            : [
                  { name: leg.departure.name, departure: leg.departure.time, datetime: leg.departure.datetime, on_leg: true },
                  { name: leg.arrival.name, arrival: leg.arrival.time, datetime: leg.arrival.datetime, on_leg: true }
              ];
        legs.push({
            ...leg,
            ...(route?.distance_km !== undefined ? { distance_km: route.distance_km } : {}),
            stops,
            remarks: (route?.remarks.slice(0, 15) ?? []).map(r => (r.length > 300 ? `${r.slice(0, 297)}…` : r))
        });
    }

    const { legs: _legs, ...head } = conn;
    const total = legs.every(l => l.distance_km !== undefined)
        ? Math.round(legs.reduce((sum, l) => sum + l.distance_km!, 0) * 10) / 10
        : undefined;
    return { ...head, ...(total !== undefined ? { distance_km: total } : {}), legs };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(iso: string): string {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`;
}

function transfersText(transfers: number): string {
    return transfers === 0 ? "direct" : `${transfers} transfer${transfers > 1 ? "s" : ""}`;
}

function delayGloss(text: string): string {
    const live = /Aktuální zpoždění\s+(\d+)/i.exec(text);
    if (live) return `live delay ${live[1]} min`;
    if (/bývá včas/i.test(text)) return "usually on time";
    if (/bývá zpožděn/i.test(text)) return "often departs late";
    return text;
}

const platformText = (stop: { platform?: string }) => (stop.platform ? ` [${stop.platform}]` : "");

function renderLeg(leg: Leg): string[] {
    const meta = [leg.mode, leg.carrier, leg.direction ? `→ ${leg.direction}` : ""].filter(Boolean).join(", ");
    const delay = leg.delay_info ? ` — ${delayGloss(leg.delay_info)}` : "";
    return [
        ...(leg.walk_before ? [`  - _${leg.walk_before}_`] : []),
        `  - **${leg.name}** (${meta}): ${leg.departure.time} ${leg.departure.name}${platformText(leg.departure)} → ${leg.arrival.time} ${leg.arrival.name}${platformText(leg.arrival)}${delay}`
    ];
}

function renderConnection(conn: Connection, index: number): string {
    const nextDay =
        conn.arrival.datetime.slice(0, 10) !== conn.departure.datetime.slice(0, 10) ? ` (${dayLabel(conn.arrival.datetime)})` : "";
    return [
        `## ${index}. ${conn.departure.time} ${conn.departure.name} → ${conn.arrival.time}${nextDay} ${conn.arrival.name}`,
        `${dayLabel(conn.departure.datetime)} · ${conn.duration || `${conn.duration_minutes} min`} · ${transfersText(conn.transfers)}`,
        ...conn.legs.flatMap(renderLeg),
        ...(conn.walk_after ? [`  - _${conn.walk_after}_`] : []),
        `connection_id: \`${conn.connection_id}\``
    ].join("\n");
}

function renderSearch(result: SearchResult, shown: Connection[]): string {
    const via = result.via?.length ? ` via ${result.via.join(", ")}` : "";
    const lines = [
        `# ${result.from} → ${result.to}${via}`,
        `${result.count} connection(s) ${result.query} · timetable ${result.timetable}`,
        ""
    ];
    if (/arriv/i.test(result.query)) {
        lines.push("_Arrive-by search: listed earliest first; the last one is the latest departure that still arrives in time._", "");
    }
    shown.forEach((conn, i) => lines.push(renderConnection(conn, i + 1), ""));
    if (shown.length < result.connections.length) {
        lines.push(
            `_Output truncated to ${shown.length} of ${result.connections.length} connections to fit the size limit; request a smaller count._`,
            ""
        );
    }
    lines.push("---");
    if (result.next_page_token) lines.push(`Later connections: call again with page_token="${result.next_page_token}"`);
    if (result.prev_page_token) lines.push(`Earlier connections: call again with page_token="${result.prev_page_token}"`);
    lines.push(`Stops of every leg: idos_get_connection_detail with a connection_id. IDOS page: ${result.idos_url}`);
    return lines.join("\n");
}

function renderStop(stop: RouteStop): string {
    const time =
        stop.arrival && stop.departure && stop.arrival !== stop.departure
            ? `${stop.arrival}–${stop.departure}`
            : (stop.departure ?? stop.arrival ?? "");
    const km = stop.km !== undefined ? ` · ${stop.km} km` : "";
    const mark = stop.on_leg ? "" : " _(not on your leg)_";
    return `  - ${time.padEnd(11)} ${stop.name}${platformText(stop)}${km}${mark}`;
}

function renderDetail(detail: ConnectionDetail, legs: LegDetail[]): string {
    const km = (distance?: number) => (distance !== undefined ? ` · ${distance} km` : "");
    const lines = [
        `# ${detail.departure.time} ${detail.departure.name} → ${detail.arrival.time} ${detail.arrival.name}`,
        `${dayLabel(detail.departure.datetime)} · ${detail.duration} · ${transfersText(detail.transfers)}${km(detail.distance_km)}`,
        ""
    ];
    legs.forEach((leg, i) => {
        if (leg.walk_before) lines.push(`_${leg.walk_before}_`, "");
        const info = [
            `${leg.departure.time} → ${leg.arrival.time} (${leg.duration_minutes} min${leg.distance_km !== undefined ? `, ${leg.distance_km} km` : ""})`,
            leg.delay_info ? delayGloss(leg.delay_info) : ""
        ].filter(Boolean);
        lines.push(
            `## Leg ${i + 1}: ${leg.name}`,
            [leg.mode, leg.carrier, leg.route].filter(Boolean).join(" · "),
            info.join(" · "),
            "",
            "Stops (arr–dep; km counted from the vehicle's first station, not from where you board):",
            ...leg.stops.map(renderStop)
        );
        if (leg.features?.length) lines.push("", `Features: ${leg.features.join("; ")}`);
        if (leg.remarks.length) lines.push("", "Notes:", ...leg.remarks.map(r => `  - ${r}`));
        lines.push("");
    });
    if (legs.length < detail.legs.length) {
        lines.push(
            `_Truncated to ${legs.length} of ${detail.legs.length} legs to fit the size limit; use include_full_route=false or response_format='json'._`
        );
    }
    if (detail.walk_after) lines.push(`_${detail.walk_after}_`);
    lines.push(`IDOS page: ${detail.url}`);
    return lines.join("\n");
}

export function registerConnectionTools(server: McpServer): void {
    server.registerTool(
        "idos_search_connections",
        {
            title: "Search journeys (connections)",
            description: `Plan a public transport journey in the Czech Republic (and cross-border) on IDOS.cz: trains, buses, city transport.

Place names are resolved through the IDOS autocomplete; diacritics are optional. A town name (e.g. "Brno") means any stop in that town. If a name is ambiguous (e.g. "Nová Ves" exists in many districts) the tool returns an error listing the exact names to use; idos_search_locations helps too.

Each connection lists departure/arrival time and stop, total time, number of transfers and every leg (service name such as "R9 (R 977 Vysočina)" or "Bus 853", type, carrier, direction, boarding/alighting stop with platform, walking transfers, and delay info when IDOS shows it). Distances and intermediate stops come from idos_get_connection_detail using the returned connection_id. Ticket prices are not available (IDOS loads them only through its ticket shop, which this read-only server never touches).

Paging: IDOS returns 3 connections per page; this tool re-searches automatically to reach 'count'. For more, pass next_page_token (later departures) or prev_page_token (earlier connections) back as page_token; you can also simply re-search with a later 'time'.

Examples:
  - "Praha to Brno tomorrow morning" -> from="Praha", to="Brno", date="2026-11-07", time="08:00"
  - "Must be in Ostrava by 18:00" -> from="Praha hl.n.", to="Ostrava", time="18:00", arrival=true
  - "Praha to Brno via Jihlava, no more than one change" -> via=["Jihlava"], max_changes=1
  - "Next connections after those" -> page_token="<next_page_token from the previous result>"`,
            inputSchema: searchInput,
            annotations: READ_ONLY_ANNOTATIONS
        },
        async (args, ctx) => {
            try {
                const result = await searchConnections(args, ctx.mcpReq.signal);
                if (args.response_format === ResponseFormat.JSON) {
                    const all = result.connections.map(conn => ({ ...conn, legs: conn.legs.map(({ route_url: _url, ...leg }) => leg) }));
                    const { shown } = fitToLimit(all, connections => JSON.stringify({ ...result, connections }, null, 2));
                    return jsonResult({
                        ...result,
                        connections: all.slice(0, shown),
                        ...(shown < all.length ? { truncated: true, total_found: all.length } : {})
                    });
                }
                return textResult(fitToLimit(result.connections, conns => renderSearch(result, conns)).text);
            } catch (error) {
                return toolErrorResult(error);
            }
        }
    );

    server.registerTool(
        "idos_get_connection_detail",
        {
            title: "Connection detail with all stops",
            description: `Show one connection from idos_search_connections in full: every leg with all intermediate stops and their arrival/departure times, platforms (when IDOS publishes them), distance in km (per leg and total; per-stop km are counted from the vehicle's first station, so subtract to get your own distance), and the carrier's notes for each service (operating days, facilities, accepted integrated tickets).

Pass the connection_id from idos_search_connections (or an https://idos.cz/.../spojeni/prehled/?p=... permalink). Makes one IDOS request plus one per leg.

Examples:
  - "Which stops does the 8:04 train make?" -> connection_id="<id of that connection>"
  - "Show the whole train route, not only my part" -> include_full_route=true`,
            inputSchema: z.strictObject({
                connection_id: z
                    .string()
                    .min(8)
                    .max(2000)
                    .describe("connection_id from an idos_search_connections result (or the IDOS permalink URL of the connection)"),
                include_full_route: z
                    .boolean()
                    .default(false)
                    .describe(
                        "true to list every stop of each vehicle's run, including stops before you board and after you alight (marked)"
                    ),
                timetable: timetableSchema,
                response_format: responseFormatSchema
            }),
            annotations: READ_ONLY_ANNOTATIONS
        },
        async ({ connection_id, include_full_route, timetable, response_format }, ctx) => {
            try {
                const detail = await getConnectionDetail(connection_id, {
                    timetable,
                    includeFullRoute: include_full_route,
                    signal: ctx.mcpReq.signal
                });
                if (response_format === ResponseFormat.JSON) {
                    const { shown } = fitToLimit(detail.legs, legs => JSON.stringify({ ...detail, legs }, null, 2));
                    return jsonResult({
                        ...detail,
                        legs: detail.legs.slice(0, shown),
                        ...(shown < detail.legs.length ? { truncated: true } : {})
                    });
                }
                const { text } = fitToLimit(detail.legs, legs => renderDetail(detail, legs));
                return textResult(
                    text.length > CHARACTER_LIMIT ? `${text.slice(0, CHARACTER_LIMIT - 80)}\n\n_Truncated to fit the size limit._` : text
                );
            } catch (error) {
                return toolErrorResult(error);
            }
        }
    );
}
