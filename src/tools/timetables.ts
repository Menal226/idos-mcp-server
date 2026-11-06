/**
 * City-line stop timetables (ZJŘ) and train routes. IDOS URLs used (all GET):
 *  - /vlakyautobusymhdvse/zjr/                       form page; embeds the city list
 *  - /vlakyautobusymhdvse/Ajax/ZJRLines/             JSONP line autocomplete (bindTtIndex = city index)
 *  - /vlakyautobusymhdvse/Ajax/ZJRStationsOnLine/    JSONP stop autocomplete for one line
 *  - /vlakyautobusymhdvse/zjr/vysledky/?l=&f=&t=&ttn=&date=&wholeweek=
 *    The ZJŘ form itself is a POST, so we call its GET results URL directly. `t` can be any later stop on the
 *    route, not only the terminus. On a wrong line/stop/direction IDOS silently re-shows the form.
 *  - /{timetable}/odjezdy/vysledky/ + Ajax/TrainDetail via the departures module (train route)
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
    clean,
    dateSchema,
    errorResult,
    fitToLimit,
    fold,
    jsonResult,
    READ_ONLY_ANNOTATIONS,
    ResponseFormat,
    responseFormatSchema,
    textResult,
    timeSchema,
    todayInPrague,
    toIdosDate,
    ToolError,
    toolErrorResult
} from "../common.js";
import { IdosError, idosGet, idosGetJsonp } from "../http.js";
import type { BoardEntry } from "../parsers/departures.js";
import { type DayTable, type ZjrCity, parseStopTimetable, parseZjrCities } from "../parsers/timetables.js";
import { fetchBoard, getTripRoute, renderTripRoute, resolveDepartureStation } from "./departures.js";

/** The ZJŘ section is the same for every timetable combination; the city is chosen with `ttn`. */
const ZJR_BASE = "/vlakyautobusymhdvse";

const CITY_CACHE_MS = 6 * 60 * 60 * 1000;
let cityCache: { at: number; cities: ZjrCity[] } | undefined;

async function getZjrCities(signal?: AbortSignal): Promise<ZjrCity[]> {
    if (cityCache && Date.now() - cityCache.at < CITY_CACHE_MS) return cityCache.cities;
    const { body } = await idosGet(`${ZJR_BASE}/zjr/`, {}, { signal });
    const cities = parseZjrCities(body).sort((a, b) => a.title.localeCompare(b.title, "cs"));
    if (cities.length === 0) {
        throw new IdosError("Could not read the list of cities from the IDOS stop-timetable page. The site may have changed.");
    }
    cityCache = { at: Date.now(), cities };
    return cities;
}

const CITY_ALIASES: Record<string, string> = { prague: "praha", pid: "praha", brunn: "brno", jmk: "brno", "ids jmk": "brno" };

function matchCity(cities: ZjrCity[], input: string): ZjrCity | undefined {
    const query = CITY_ALIASES[fold(input)] ?? fold(input);
    const scored = cities
        .map(city => {
            const title = fold(city.title);
            const inner = /\(([^)]+)\)/.exec(title)?.[1] ?? "";
            const bare = title.replace(/\s*\(.*\)\s*/, "").trim();
            let score = 0;
            if (fold(city.code) === query || title === query || inner === query || bare === query) score = 3;
            else if (inner.startsWith(query) || bare.startsWith(query) || title.startsWith(query)) score = 2;
            else if (title.includes(query)) score = 1;
            return { city, score };
        })
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score || Number(b.city.major) - Number(a.city.major));
    return scored[0]?.city;
}

async function resolveCity(input: string, signal?: AbortSignal): Promise<ZjrCity> {
    const cities = await getZjrCities(signal);
    const city = matchCity(cities, input);
    if (city) return city;
    const major = cities.filter(c => c.major).map(c => c.title);
    throw new ToolError(
        `IDOS has no city-line timetables for '${input}'. Larger systems: ${major.join(", ")}. ` +
            "Call idos_list_city_timetables for all supported cities. For regional/long-distance buses and trains use " +
            "idos_get_train_route or the departures/connection tools instead."
    );
}

interface RawAutocomplete {
    selectedText: string;
    text: string;
    value: string | null;
    from: string | null;
    to: string | null;
}

interface LineVariant {
    line: string;
    number: string;
    from: string;
    to: string;
}

/** "Bus 136" -> "136" */
function lineNumberOf(label: string): string {
    const parts = clean(label).split(" ");
    return parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
}

function zjrAutocomplete(
    endpoint: string,
    city: ZjrCity,
    params: Record<string, string | number | boolean>,
    date?: string,
    signal?: AbortSignal
) {
    return idosGetJsonp<RawAutocomplete[] | null>(
        `${ZJR_BASE}/Ajax/${endpoint}/`,
        { ...params, searchByPosition: false, format: "json", bindTtIndex: city.index, date: toIdosDate(date) ?? "" },
        { signal }
    );
}

async function searchLineVariants(city: ZjrCity, query: string, date?: string, signal?: AbortSignal): Promise<LineVariant[]> {
    const raw = await zjrAutocomplete(
        "ZJRLines",
        city,
        { count: 50, prefixText: lineNumberOf(query), onlyStation: false, line: "" },
        date,
        signal
    );
    const variants = new Map<string, LineVariant>();
    for (const item of raw ?? []) {
        const line = clean(item.selectedText || item.text);
        const variant = { line, number: clean(item.value) || lineNumberOf(line), from: clean(item.from), to: clean(item.to) };
        const key = `${variant.line}|${variant.from}|${variant.to}`;
        if (line && !variants.has(key)) variants.set(key, variant);
    }
    return [...variants.values()];
}

/** Variants whose number equals the query exactly (so "1" does not pick up "10" or "100"). */
function exactVariants(variants: LineVariant[], query: string): LineVariant[] {
    const q = fold(query);
    const qNumber = fold(lineNumberOf(query));
    return variants.filter(v => fold(v.line) === q || fold(v.number) === q || fold(v.number) === qNumber);
}

async function exactLineVariants(city: ZjrCity, line: string, date?: string, signal?: AbortSignal): Promise<LineVariant[]> {
    const variants = exactVariants(await searchLineVariants(city, line, date, signal), line);
    if (variants.length === 0)
        throw new ToolError(`No line '${line}' in ${city.title}. Use idos_search_lines to find the exact line number.`);
    return variants;
}

async function searchStopsOnLine(city: ZjrCity, line: string, prefix: string, date?: string, signal?: AbortSignal): Promise<string[]> {
    const raw = await zjrAutocomplete(
        "ZJRStationsOnLine",
        city,
        { count: 20, prefixText: prefix || "*", onlyStation: true, line: lineNumberOf(line) },
        date,
        signal
    );
    return [...new Set((raw ?? []).map(item => clean(item.selectedText || item.text)).filter(Boolean))];
}

async function fetchStopTimetable(
    city: ZjrCity,
    line: string,
    stop: string,
    direction: string,
    options: { date?: string; wholeWeek?: boolean; signal?: AbortSignal }
) {
    const { body, url } = await idosGet(
        `${ZJR_BASE}/zjr/vysledky/`,
        {
            l: line,
            f: stop,
            t: direction,
            ttn: city.code,
            date: toIdosDate(options.date),
            wholeweek: options.wholeWeek ? "true" : undefined
        },
        { signal: options.signal }
    );
    const parsed = parseStopTimetable(body);
    return parsed && { ...parsed, idos_url: url };
}

/** IDOS gives no reason when it re-shows the form, so work out which input was wrong. */
async function diagnoseZjrFailure(
    city: ZjrCity,
    line: string,
    stop: string,
    direction: string,
    date: string | undefined,
    signal: AbortSignal | undefined
): Promise<string> {
    const variants = exactVariants(await searchLineVariants(city, line, date, signal), line);
    if (variants.length === 0) {
        return (
            `IDOS does not know line '${line}' in ${city.title}. Use idos_search_lines (city='${city.title}') to find the exact line, ` +
            "or check the city: each city's lines are separate."
        );
    }
    const label = variants[0].line;
    const problems: string[] = [];
    for (const [role, name] of [
        ["Stop", stop],
        ["Direction", direction]
    ]) {
        const matches = await searchStopsOnLine(city, label, name, date, signal);
        if (matches.some(m => fold(m) === fold(name))) continue;
        problems.push(
            matches.length
                ? `${role} '${name}' is not an exact stop name of ${label}; did you mean: ${matches.slice(0, 8).join(", ")}?`
                : `${role} '${name}' is not a stop of ${label} in ${city.title}.`
        );
    }
    const termini = [...new Set(variants.flatMap(v => [v.from, v.to]))].join(", ");
    problems.push(
        problems.length
            ? `Termini of ${label}: ${termini}.`
            : `IDOS could not build a timetable for these stops. The direction must be a stop served after the departure stop on the same route ` +
                  `(termini of ${label}: ${termini}), and the line must run on the chosen date.`
    );
    return problems.join(" ");
}

function formatDayTables(tables: DayTable[]): string[] {
    const lines: string[] = [];
    for (const table of tables) {
        lines.push(`### ${table.label || "Departures"}`, "", "| Hour | Minutes |", "|---:|---|");
        for (const row of table.hours) {
            const minutes = row.departures.map(d => `${String(d.minute).padStart(2, "0")}${d.marks}`).join(" ");
            const interval = row.interval_minutes ? `, then every ${row.interval_minutes} min until the next hour` : "";
            lines.push(`| ${row.hour} | ${minutes || "–"}${interval} |`);
        }
        lines.push("");
    }
    return lines;
}

function departureCount(table: DayTable): number {
    return table.hours.reduce((sum, row) => sum + row.departures.length, 0);
}

function firstLast(table: DayTable): { first?: string; last?: string } {
    const all = table.hours.flatMap(row => row.departures.map(d => `${row.hour}:${String(d.minute).padStart(2, "0")}`));
    return { first: all[0], last: all[all.length - 1] };
}

function matchesTrain(entry: BoardEntry, query: string): "number" | "name" | false {
    // Bus line numbers are zero-padded ("000219"); compare numbers without leading zeros.
    const unpad = (text: string) => text.replace(/(^|\s)0+(?=\d)/g, "$1");
    const q = unpad(fold(query));
    const squashed = q.replace(/\s+/g, "");
    const number = unpad(fold(entry.number));
    const label = `${fold(entry.category)} ${number}`;
    if (label === q || label.replace(/\s+/g, "") === squashed) return "number";
    if (/^\d+$/.test(squashed) && number === squashed) return "number";
    if (entry.train_name) {
        const name = fold(entry.train_name);
        if (`${label} ${name}` === q) return "number";
        if (!/^\d+$/.test(squashed) && squashed.length >= 3 && name.includes(q)) return "name";
    }
    return false;
}

function addMinutes(hhmm: string, minutes: number): string {
    const [h, m] = hhmm.split(":").map(Number);
    const total = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + minutes));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** D.M.YYYY without leading zeros and with the year filled in, as the board entries carry it. */
function boardDate(date: string | undefined): string {
    const [d, m, y] = toIdosDate(date ?? todayInPrague())!.split(".");
    return `${Number(d)}.${Number(m)}.${y || todayInPrague().slice(0, 4)}`;
}

/**
 * IDOS has no train-number search, so page through one day of a station's departure board until entries
 * matching `train` appear.
 */
async function findTrainAtStation(options: {
    train: string;
    station: string;
    timetable: string;
    idosDate: string;
    time?: string;
    maxPages: number;
    signal?: AbortSignal;
}): Promise<{ station: string; matches: BoardEntry[]; scanned: string; pages: number }> {
    const resolution = await resolveDepartureStation(options.station, options.timetable, options.signal);
    if (!resolution.ok) throw new ToolError(resolution.message.replace("idos_get_departures", "idos_get_train_route"));
    const station = resolution.station;

    const startTime = options.time ? addMinutes(options.time, -30) : "0:00";
    let time = startTime;
    let lastSeen = startTime;
    let boardName = station.name;
    const seen = new Set<string>();
    for (let page = 1; page <= options.maxPages; page++) {
        const board = await fetchBoard(station, {
            timetable: options.timetable,
            arrivals: false,
            date: options.idosDate,
            time,
            signal: options.signal
        });
        if ("error" in board) {
            if (page > 1) break;
            const validity = board.validity ? ` Timetable data covers ${board.validity.from} to ${board.validity.to}.` : "";
            throw new ToolError(`IDOS returned no departure board for '${station.name}' on ${options.idosDate}.${validity}`);
        }
        boardName = board.station || boardName;
        const sameDay = board.entries.filter(e => e.date === options.idosDate);
        const fresh = sameDay.filter(e => !seen.has(e.key) && (seen.add(e.key), true));
        if (sameDay.length) lastSeen = sameDay[sameDay.length - 1].time.replace(/^0(?=\d)/, "");

        const byNumber = fresh.filter(e => matchesTrain(e, options.train) === "number");
        const matches = byNumber.length ? byNumber : fresh.filter(e => matchesTrain(e, options.train) === "name");
        if (matches.length) return { station: boardName, matches, scanned: `${startTime}–${lastSeen}`, pages: page };
        // Stop at the end of the day, or when the board stops moving.
        const last = board.entries[board.entries.length - 1];
        if (!last || sameDay.length < board.entries.length) {
            return { station: boardName, matches: [], scanned: `${startTime}–23:59`, pages: page };
        }
        time = fresh.length === 0 ? addMinutes(last.time, 1) : last.time;
        if (fresh.length === 0 && last.time === "23:59") break;
    }
    return { station: boardName, matches: [], scanned: `${startTime}–${lastSeen}`, pages: options.maxPages };
}

const citySchema = z
    .string()
    .min(2)
    .max(64)
    .default("Praha")
    .describe(
        "City whose city-transport lines to use, e.g. 'Praha' (PID), 'Brno' (IDS JMK), 'Ostrava', 'Plzeň', 'Olomouc', 'Liberec'. Default 'Praha'. See idos_list_city_timetables."
    );

const lineSchema = z
    .string()
    .min(1)
    .max(32)
    .describe("Line number or label as shown by idos_search_lines, e.g. '136', 'Bus 136', 'Tram 22', 'A' (metro)");

export function registerTimetableTools(server: McpServer): void {
    server.registerTool(
        "idos_list_city_timetables",
        {
            title: "List cities with line timetables",
            description: `List the cities and integrated systems whose city-transport lines (bus, tram, trolleybus, metro) have stop timetables on IDOS.

Use the returned title (or a short form like 'Praha', 'Brno') as the \`city\` argument of idos_search_lines, idos_get_line_route and idos_get_stop_timetable.
Major systems are flagged. Example: "Which cities can I get tram timetables for?" -> call with no arguments.`,
            inputSchema: z.strictObject({ response_format: responseFormatSchema }),
            annotations: READ_ONLY_ANNOTATIONS
        },
        async ({ response_format }, ctx) => {
            try {
                const cities = await getZjrCities(ctx.mcpReq.signal);
                if (response_format === ResponseFormat.JSON) {
                    return jsonResult({
                        count: cities.length,
                        cities: cities.map(c => ({ title: c.title, code: c.code, major: c.major }))
                    });
                }
                const major = cities.filter(c => c.major).map(c => `**${c.title}**`);
                const other = cities.filter(c => !c.major).map(c => c.title);
                return textResult(
                    [
                        `# Cities with line timetables (${cities.length})`,
                        "",
                        `Major: ${major.join(", ")}`,
                        "",
                        `Other: ${other.join(", ")}`
                    ].join("\n")
                );
            } catch (error) {
                return toolErrorResult(error);
            }
        }
    );

    server.registerTool(
        "idos_search_lines",
        {
            title: "Search city lines",
            description: `Find a city-transport line (bus, tram, trolleybus, metro, ferry) by number in one city and list its route variants (first stop -> last stop).

Use it before idos_get_line_route / idos_get_stop_timetable to get the exact line label and its directions.
Examples:
  - "Prague bus 136" -> city='Praha', query='136'
  - "Brno tram 1" -> city='Brno', query='1'
  - "Ostrava trolleybus 101" -> city='Ostrava', query='101'
Covers city lines only. For a train or regional/long-distance bus by number use idos_get_train_route.`,
            inputSchema: z.strictObject({
                city: citySchema,
                query: z.string().min(1).max(32).describe("Line number or its beginning, e.g. '136', '22', 'A', 'Tram 9'"),
                date: dateSchema,
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(50)
                    .default(20)
                    .describe("Maximum number of route variants to return (1-50, default 20)"),
                response_format: responseFormatSchema
            }),
            annotations: READ_ONLY_ANNOTATIONS
        },
        async ({ city, query, date, limit, response_format }, ctx) => {
            try {
                const resolved = await resolveCity(city, ctx.mcpReq.signal);
                const all = await searchLineVariants(resolved, query, date, ctx.mcpReq.signal);
                const exact = exactVariants(all, query);
                const variants = (exact.length ? exact : all).slice(0, limit);
                if (variants.length === 0) {
                    return errorResult(
                        `No line '${query}' in ${resolved.title}. Check the number, or the city (each city's lines are separate; see idos_list_city_timetables). ` +
                            "For trains and long-distance buses use idos_get_train_route."
                    );
                }
                if (response_format === ResponseFormat.JSON) {
                    return jsonResult({ city: resolved.title, query, count: variants.length, lines: variants });
                }
                const { text } = fitToLimit(variants, shown =>
                    [
                        `# Lines matching '${query}' in ${resolved.title}`,
                        "",
                        ...shown.map(v => `- **${v.line}**: ${v.from} → ${v.to}`),
                        "",
                        "Next: idos_get_line_route (line, direction=<last stop>) for all stops, or idos_get_stop_timetable (line, stop, direction) for departures at a stop."
                    ].join("\n")
                );
                return textResult(text);
            } catch (error) {
                return toolErrorResult(error);
            }
        }
    );

    server.registerTool(
        "idos_get_line_route",
        {
            title: "Get a city line's stops",
            description: `List all stops of a city line in order, with scheduled travel minutes from the first stop, tariff zones and stop attributes (request stop, metro transfer, step-free), plus how often it runs from the first stop.

Examples:
  - "Which stops does Prague bus 136 serve towards Jižní Město?" -> city='Praha', line='136', direction='Jižní Město'
  - "Route of Brno tram 1" -> city='Brno', line='1'
If direction is omitted, the first route variant IDOS lists is used and the other directions are named in the output.`,
            inputSchema: z.strictObject({
                city: citySchema,
                line: lineSchema,
                direction: z
                    .string()
                    .min(2)
                    .max(128)
                    .optional()
                    .describe(
                        "Last stop of the route variant (as listed by idos_search_lines), e.g. 'Jižní Město'. Omit to use the first variant."
                    ),
                date: dateSchema,
                response_format: responseFormatSchema
            }),
            annotations: READ_ONLY_ANNOTATIONS
        },
        async ({ city, line, direction, date, response_format }, ctx) => {
            const signal = ctx.mcpReq.signal;
            try {
                const resolved = await resolveCity(city, signal);
                const variants = await exactLineVariants(resolved, line, date, signal);
                let variant = variants[0];
                if (direction) {
                    const wanted = fold(direction);
                    const found = variants.find(v => fold(v.to) === wanted) ?? variants.find(v => fold(v.to).includes(wanted));
                    if (!found) {
                        const dirs = [...new Set(variants.map(v => v.to))].join(", ");
                        return errorResult(
                            `${variants[0].line} in ${resolved.title} has no route variant ending at '${direction}'. Its directions: ${dirs}.`
                        );
                    }
                    variant = found;
                }
                const timetable = await fetchStopTimetable(resolved, variant.line, variant.from, variant.to, { date, signal });
                if (!timetable) {
                    return errorResult(
                        `IDOS could not show ${variant.line} ${variant.from} → ${variant.to} in ${resolved.title}${date ? ` on ${date}` : ""}. ` +
                            "The line may not run that day; try another date or direction."
                    );
                }
                const others = variants.filter(v => v !== variant).map(v => `${v.from} → ${v.to}`);
                const day = timetable.tables[0];
                const summary = day
                    ? {
                          day: day.label,
                          departures: departureCount(day),
                          interval_hours: day.hours.filter(h => h.interval_minutes).map(h => h.hour),
                          ...firstLast(day)
                      }
                    : null;
                if (response_format === ResponseFormat.JSON) {
                    return jsonResult({
                        city: resolved.title,
                        line: timetable.line,
                        from: variant.from,
                        to: variant.to,
                        stops: timetable.stops.map(({ selected: _selected, ...stop }) => stop),
                        departures_from_first_stop: summary,
                        other_variants: others,
                        notes: timetable.notes,
                        idos_url: timetable.idos_url
                    });
                }
                const { text } = fitToLimit(timetable.stops, shown => {
                    const out = [`# ${timetable.line}: ${variant.from} → ${variant.to} (${resolved.title})`, ""];
                    if (summary) {
                        const span = summary.first ? `, first ${summary.first}, last ${summary.last}` : "";
                        const intervals = summary.interval_hours.length
                            ? ` (plus interval service in hour(s) ${summary.interval_hours.join(", ")}, not counted)`
                            : "";
                        out.push(`${summary.day}: ${summary.departures} listed departures from ${variant.from}${intervals}${span}.`, "");
                    }
                    out.push("| Min. | Stop | Zone | Attributes |", "|---:|---|---|---|");
                    out.push(...shown.map(s => `| ${s.minutes ?? ""} | ${s.name} | ${s.zone} | ${s.codes.join("; ")} |`), "");
                    if (shown.length < timetable.stops.length)
                        out.push(`_Showing ${shown.length} of ${timetable.stops.length} stops._`, "");
                    if (others.length) out.push(`Other variants: ${others.join("; ")}`);
                    if (timetable.notes.length) out.push(`Notes: ${timetable.notes.join("; ")}`);
                    out.push(`IDOS page: ${timetable.idos_url}`);
                    return out.join("\n");
                });
                return textResult(text);
            } catch (error) {
                return toolErrorResult(error);
            }
        }
    );

    server.registerTool(
        "idos_get_stop_timetable",
        {
            title: "Get a line's timetable at a stop",
            description: `Get the posted stop timetable (zastávkový jízdní řád) of one city line at one stop in one direction: departures grouped by hour, for a date or a whole week (workdays / Saturday / Sunday), with footnotes, travel minutes to the following stops and the other lines at that stop.

Examples:
  - "When does bus 136 leave Flora towards Jižní Město?" -> city='Praha', line='136', stop='Flora', direction='Jižní Město'
  - "Brno tram 1 from Hlavní nádraží to Ečerova, weekly timetable" -> city='Brno', line='1', stop='Hlavní nádraží', direction='Ečerova', whole_week=true
direction can be the last stop or any later stop on the route. If omitted, the first variant's last stop is used.
Stop names must match IDOS exactly; on a mismatch the error lists close matches. For live departures of all lines at a stop use idos_get_departures.`,
            inputSchema: z.strictObject({
                city: citySchema,
                line: lineSchema,
                stop: z.string().min(2).max(128).describe("Stop to get departures from, e.g. 'Flora', 'Hlavní nádraží'"),
                direction: z
                    .string()
                    .min(2)
                    .max(128)
                    .optional()
                    .describe(
                        "A later stop on the line that sets the direction, usually the last stop, e.g. 'Jižní Město'. Omit to use the first variant's last stop."
                    ),
                date: dateSchema,
                whole_week: z
                    .boolean()
                    .default(false)
                    .describe("true for the whole week's timetable (workdays, Saturday, Sunday/holidays) instead of a single date"),
                response_format: responseFormatSchema
            }),
            annotations: READ_ONLY_ANNOTATIONS
        },
        async ({ city, line, stop, direction, date, whole_week, response_format }, ctx) => {
            const signal = ctx.mcpReq.signal;
            try {
                const resolved = await resolveCity(city, signal);
                let towards = direction;
                let lineLabel = line;
                if (!towards) {
                    const variants = await exactLineVariants(resolved, line, date, signal);
                    lineLabel = variants[0].line;
                    towards = (variants.find(v => fold(v.to) !== fold(stop)) ?? variants[0]).to;
                }
                const timetable = await fetchStopTimetable(resolved, lineLabel, stop, towards, { date, wholeWeek: whole_week, signal });
                if (!timetable) return errorResult(await diagnoseZjrFailure(resolved, lineLabel, stop, towards, date, signal));

                const lineNumber = fold(lineNumberOf(timetable.line));
                const otherDirections = timetable.lines_at_stop
                    .filter(l => fold(l.line) === lineNumber && fold(l.direction) !== fold(towards))
                    .map(l => l.direction);
                const otherLines = timetable.lines_at_stop.filter(l => fold(l.line) !== lineNumber);
                const stopName = timetable.stop ?? stop;
                const selectedAt = timetable.stops.findIndex(s => s.selected);
                const following = (
                    selectedAt >= 0 ? timetable.stops.slice(selectedAt + 1) : timetable.stops.filter(s => s.minutes !== null)
                ).map(s => ({ name: s.name, minutes: s.minutes }));

                if (response_format === ResponseFormat.JSON) {
                    return jsonResult({
                        city: resolved.title,
                        line: timetable.line,
                        stop: stopName,
                        direction: towards,
                        whole_week,
                        tables: timetable.tables,
                        following_stops: following,
                        notes: timetable.notes,
                        other_directions: otherDirections,
                        lines_at_stop: timetable.lines_at_stop,
                        idos_url: timetable.idos_url
                    });
                }
                const heading = `# ${timetable.line} at ${stopName} → ${towards} (${resolved.title})`;
                if (timetable.tables.every(t => departureCount(t) === 0)) {
                    return textResult(
                        `${heading}\n\nNo departures in this direction${date ? ` on ${date}` : " today"}. ` +
                            `Try whole_week=true, another date${otherDirections.length ? `, or direction '${otherDirections[0]}'` : ""}.`
                    );
                }
                const { text } = fitToLimit(timetable.tables, shown => {
                    const out = [heading, "", ...formatDayTables(shown)];
                    if (shown.length < timetable.tables.length)
                        out.push(`_Showing ${shown.length} of ${timetable.tables.length} day tables._`, "");
                    if (timetable.notes.length) out.push(`**Notes:** ${timetable.notes.join("; ")}`, "");
                    if (following.length) {
                        out.push(
                            `**Travel time from ${stopName}:** ${following.map(s => `${s.name} ${s.minutes ?? "?"} min`).join(", ")}`,
                            ""
                        );
                    }
                    if (otherDirections.length) out.push(`Other direction(s) of this line: ${otherDirections.join(", ")}`);
                    if (otherLines.length)
                        out.push(`Other lines at ${stopName}: ${otherLines.map(l => `${l.line} → ${l.direction}`).join(", ")}`);
                    out.push(`IDOS page: ${timetable.idos_url}`);
                    return out.join("\n");
                });
                return textResult(text);
            } catch (error) {
                return toolErrorResult(error);
            }
        }
    );

    server.registerTool(
        "idos_get_train_route",
        {
            title: "Get a train's route by number",
            description: `Find a train (or a regional/long-distance bus) by its number or name at a station it departs from, and return its full route: every stop with arrival, departure and distance in km, service features and restrictions.

It scans that station's departure board for the given day, so name a station where the service DEPARTS (not its final stop). ALWAYS pass time (approximate departure there) when you can: without it, scanning starts at midnight and at big stations the default max_pages covers only the early morning.
Examples:
  - "Route of R 871 from Praha hl.n. tomorrow" -> train='R 871', station='Praha hl.n.', date='<tomorrow>'
  - "Where does EC 171 stop?" -> train='EC 171', station='Praha hl.n.'
  - "Pendolino leaving Ostrava around 9" -> train='Pendolino', station='Ostrava hl.n.', time='09:00'
  - Long-distance bus -> timetable='autobusy', train='<line number>', station='<departure stop>'
A name (e.g. 'Pendolino') can match several trains; then the matches are listed so you can pick one by number.`,
            inputSchema: z.strictObject({
                train: z
                    .string()
                    .min(1)
                    .max(64)
                    .describe(
                        "Train category and number, number alone, or name, e.g. 'R 871', 'EC 171', '871', 'Os 2501', 'Pendolino', 'Ostravan'"
                    ),
                station: z
                    .string()
                    .min(2)
                    .max(128)
                    .describe(
                        "Exact IDOS name of a station where the train departs, e.g. 'Praha hl.n.', 'Brno hl.n.', 'Ostrava hl.n.' (see idos_search_locations)"
                    ),
                date: dateSchema,
                time: timeSchema.describe(
                    "Approximate departure time at that station, HH:MM. Scanning starts 30 minutes earlier. Omit to scan from midnight (slower at big stations)."
                ),
                timetable: z
                    .string()
                    .regex(/^[a-z0-9]+$/, "Lowercase letters and digits only, e.g. 'vlaky', 'autobusy'")
                    .default("vlaky")
                    .describe(
                        "IDOS timetable: 'vlaky' (trains, default), 'autobusy' (long-distance buses), 'vlakyautobusymhdvse' (everything)"
                    ),
                max_pages: z
                    .number()
                    .int()
                    .min(1)
                    .max(15)
                    .default(6)
                    .describe("How many departure-board pages (roughly 30 departures each) to scan before giving up (1-15, default 6)"),
                response_format: responseFormatSchema
            }),
            annotations: READ_ONLY_ANNOTATIONS
        },
        async ({ train, station, date, time, timetable, max_pages, response_format }, ctx) => {
            const signal = ctx.mcpReq.signal;
            try {
                const idosDate = boardDate(date);
                const search = await findTrainAtStation({ train, station, timetable, idosDate, time, maxPages: max_pages, signal });
                if (search.matches.length === 0) {
                    return errorResult(
                        `No departure of '${train}' found at ${search.station} on ${idosDate} between ${search.scanned} (${search.pages} board page(s) scanned). ` +
                            "Check that the train departs from this station on that day (not just arrives), pass `time` near its departure, " +
                            "raise max_pages, or use the category with the number (e.g. 'R 871'). For buses set timetable='autobusy'."
                    );
                }
                const distinct = [...new Map(search.matches.map(m => [`${m.category} ${m.number}`, m])).values()];
                if (distinct.length > 1) {
                    const list = distinct.map(m => ({
                        train: `${m.category} ${m.number}`,
                        name: m.train_name,
                        departure: `${m.date} ${m.time}`,
                        destination: m.destination,
                        trip_id: m.trip_id
                    }));
                    if (response_format === ResponseFormat.JSON) {
                        return jsonResult({ ambiguous: true, station: search.station, query: train, matches: list });
                    }
                    return textResult(
                        [
                            `# Several services match '${train}' at ${search.station}`,
                            "",
                            ...list.map(
                                m =>
                                    `- **${m.train}**${m.name ? ` ${m.name}` : ""}, departs ${m.departure} → ${m.destination} (trip_id: \`${m.trip_id}\`)`
                            ),
                            "",
                            `Call again with the exact train (e.g. train='${list[0].train}'), or pass a trip_id to idos_get_trip_route.`
                        ].join("\n")
                    );
                }
                const entry = distinct[0];
                const route = await getTripRoute(entry.trip_id, signal);
                if ("error" in route) return errorResult(route.error);
                if (response_format === ResponseFormat.JSON) {
                    return jsonResult({
                        train: `${entry.category} ${entry.number}`,
                        name: entry.train_name,
                        board: {
                            station: search.station,
                            departure: `${entry.date} ${entry.time}`,
                            destination: entry.destination,
                            platform: entry.platform,
                            carrier: entry.carrier,
                            category: entry.category_name
                        },
                        trip_id: entry.trip_id,
                        ...route
                    });
                }
                const { text } = fitToLimit(route.stops, stops => renderTripRoute({ ...route, stops }));
                return textResult(text);
            } catch (error) {
                return toolErrorResult(error);
            }
        }
    );
}
