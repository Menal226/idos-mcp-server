import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
    clean,
    fitToLimit,
    jsonResult,
    READ_ONLY_ANNOTATIONS,
    ResponseFormat,
    responseFormatSchema,
    textResult,
    timetableSchema
} from "../common.js";
import { idosGetJsonp } from "../http.js";

interface RawLocation {
    selectedText: string;
    text: string;
    description: string | null;
    region: string | null;
    value: string | null;
    value2: string | null;
    coorX: number | null;
    coorY: number | null;
}

export interface Location {
    name: string;
    kind: string;
    region: string;
    modes: string[];
    /** IDOS place type: 1 town, 2 part of town, 100003 station, 200003 stop, 8 address. */
    object_class: string;
    object_id: string;
    lat?: number;
    lon?: number;
}

function toLocation(raw: RawLocation): Location {
    // description reads "<kind>, <region>, <mode>, <mode>...", e.g. "stanice, okres Brno-město, vlaky, autobusy, MHD"
    const [kind = "", regionPart = "", ...modes] = clean(raw.description)
        .split(",")
        .map(part => part.trim())
        .filter(Boolean);
    return {
        name: clean(raw.selectedText || raw.text),
        kind,
        region: clean(raw.region) || regionPart,
        modes,
        object_class: raw.value ?? "",
        object_id: raw.value2 ?? "",
        ...(typeof raw.coorX === "number" && raw.coorX !== 0 ? { lat: raw.coorX } : {}),
        ...(typeof raw.coorY === "number" && raw.coorY !== 0 ? { lon: raw.coorY } : {})
    };
}

export async function searchLocations(
    query: string,
    options: { timetable: string; limit: number; onlyStations?: boolean; signal?: AbortSignal }
): Promise<Location[]> {
    const raw = await idosGetJsonp<RawLocation[] | null>(
        `/${options.timetable}/Ajax/SearchTimetableObjects/`,
        {
            count: options.limit,
            prefixText: query,
            searchByPosition: false,
            onlyStation: options.onlyStations ?? false,
            format: "json"
        },
        { signal: options.signal }
    );
    return (raw ?? []).map(toLocation);
}

export function registerLocationTools(server: McpServer): void {
    server.registerTool(
        "idos_search_locations",
        {
            title: "Search stations and places",
            description: `Find IDOS stations, stops and municipalities matching a (partial) name. Czech diacritics are optional.

Use this first when a place name is ambiguous or you get "not found" errors from other tools: pass the returned \`name\` exactly as the from/to/station argument of idos_search_connections or idos_get_departures.

Examples:
  - "Which Brno stations are there?" -> query="Brno"
  - "Find Praha hlavní nádraží" -> query="Praha hl"
Returns name, kind (obec = municipality, stanice = station, zastávka = stop), region, served modes and coordinates.`,
            inputSchema: z.strictObject({
                query: z.string().min(2).max(128).describe("Start of the place name, e.g. 'Brno', 'Praha hl', 'Olomouc'"),
                limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of matches (1-50, default 10)"),
                only_stations: z.boolean().default(false).describe("true to return only concrete stations/stops, not municipalities"),
                timetable: timetableSchema,
                response_format: responseFormatSchema
            }),
            annotations: READ_ONLY_ANNOTATIONS
        },
        async ({ query, limit, only_stations, timetable, response_format }, ctx) => {
            const locations = await searchLocations(query, { timetable, limit, onlyStations: only_stations, signal: ctx.mcpReq.signal });
            if (response_format === ResponseFormat.JSON) {
                return jsonResult({ query, count: locations.length, locations });
            }
            if (locations.length === 0) {
                return textResult(`No IDOS locations match '${query}'. Try fewer letters, or check the spelling.`);
            }
            const { text } = fitToLimit(locations, shown =>
                [
                    `# Locations matching '${query}'`,
                    "",
                    ...shown.map(loc => {
                        const extra = [loc.kind, loc.region, loc.modes.join(", ")].filter(Boolean).join(" · ");
                        const coords =
                            loc.lat !== undefined && loc.lon !== undefined ? ` (${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)})` : "";
                        return `- **${loc.name}** — ${extra}${coords}`;
                    })
                ].join("\n")
            );
            return textResult(text);
        }
    );
}
