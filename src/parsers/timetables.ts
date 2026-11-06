/**
 * Parsers for the ZJŘ pages (zastávkové jízdní řády, stop timetables of city lines):
 * the city list on /vlakyautobusymhdvse/zjr/ and the results page /vlakyautobusymhdvse/zjr/vysledky/.
 */
import * as cheerio from "cheerio";
import { clean } from "../common.js";

export interface ZjrCity {
    title: string;
    /** Sent as `ttn=` on the results URL, e.g. "PID_VK". */
    code: string;
    /** Sent as `bindTtIndex=` to the line / stop autocomplete endpoints. */
    index: number;
    /** IDOS highlights the larger systems in bold. */
    major: boolean;
}

export function parseZjrCities(html: string): ZjrCity[] {
    const $ = cheerio.load(html);
    const cities = new Map<string, ZjrCity>();
    $("a[data-tt-name][data-tt-index]").each((_, el) => {
        const a = $(el);
        const code = clean(a.attr("data-tt-name"));
        const index = Number(a.attr("data-tt-index"));
        if (!code || !Number.isFinite(index) || cities.has(code)) return;
        cities.set(code, { title: clean(a.attr("data-tt-title")) || code, code, index, major: a.hasClass("bold") });
    });
    return [...cities.values()];
}

interface LineStop {
    name: string;
    /** Minutes from the selected stop; null for stops before it. */
    minutes: number | null;
    selected: boolean;
    zone: string;
    codes: string[];
}

interface HourRow {
    hour: number;
    departures: { minute: number; marks: string }[];
    /** Headway such as "3-4" when IDOS lists an interval instead of every departure. */
    interval_minutes?: string;
}

export interface DayTable {
    label: string;
    hours: HourRow[];
}

export interface StopTimetable {
    line: string;
    stop: string | null;
    stops: LineStop[];
    tables: DayTable[];
    notes: string[];
    lines_at_stop: { line: string; direction: string }[];
}

function parseInteger(text: string): number | null {
    const match = /-?\d+/.exec(text);
    return match ? Number(match[0]) : null;
}

/** null when IDOS re-showed the search form, i.e. it did not recognise the line, stop or direction. */
export function parseStopTimetable(html: string): StopTimetable | null {
    const $ = cheerio.load(html);
    const title = clean($(".zjr-panel .departures__title").first().text());
    if (!title || $(".zjr-stations").length === 0) return null;

    const stops: LineStop[] = [];
    let selectedStop: string | null = null;
    $(".zjr-stations table.zjr-table tbody tr").each((_, el) => {
        const row = $(el);
        const nameCell = row.find("td.zjr-table__station_name").first();
        const link = nameCell.find("a.fromStation").first();
        const bold = nameCell.children("span.bold").first();
        const name = clean(link.length ? link.text() : bold.length ? bold.text() : nameCell.text());
        if (!name) return;
        // The selected stop is the one bold row without a link.
        const selected = !link.length && bold.length > 0;
        if (selected) selectedStop = name;
        const codes = nameCell
            .find("span[title]")
            .map((__, span) => clean($(span).attr("title")))
            .get()
            .filter(Boolean);
        stops.push({
            name,
            minutes: parseInteger(clean(row.find("td.zjr-table__time").first().text())),
            selected,
            zone: clean(row.find("td.tarif").first().text()),
            codes: [...new Set(codes)]
        });
    });

    const tables: DayTable[] = [];
    $(".zjr-tables-wrap table.zjr-table.times").each((_, el) => {
        const table = $(el);
        const hours: HourRow[] = [];
        table.find("tbody tr").each((__, tr) => {
            const cells = $(tr).find("td");
            const hour = parseInteger(clean(cells.first().text()));
            if (hour === null) return;
            // An interval hour reads "01 int. 3-4 min.": listed departures, then a headway for the rest of the hour.
            const text = clean(cells.eq(1).text());
            const interval = /\bint\.?\s*(\d+(?:\s*-\s*\d+)?)\s*min\.?/i.exec(text);
            const listed = interval ? text.slice(0, interval.index) : text;
            const departures = listed
                .split(" ")
                .map(token => /^(\d{1,2})(\D*)$/.exec(token))
                .filter(match => match !== null)
                .map(match => ({ minute: Number(match[1]), marks: match[2] }));
            hours.push({ hour, departures, ...(interval ? { interval_minutes: interval[1].replace(/\s+/g, "") } : {}) });
        });
        tables.push({ label: clean(table.find("thead th").last().text()), hours });
    });

    const notes = $(".remarks-list .remarks-list__item")
        .map((_, el) => clean($(el).text()))
        .get()
        .filter(Boolean);

    const linesAtStop: StopTimetable["lines_at_stop"] = [];
    $("#alt-directions option").each((_, el) => {
        // value = "<stop>%<stopId>%<direction>%<directionId>%<line>%<lineIndex>"
        const parts = ($(el).attr("value") ?? "").split("%");
        if (parts.length >= 6) linesAtStop.push({ line: clean(parts[4]), direction: clean(parts[2]) });
    });

    return {
        line: title.replace(/^Linka\s+/i, ""),
        stop: selectedStop,
        stops,
        tables,
        notes: [...new Set(notes)],
        lines_at_stop: linesAtStop
    };
}
