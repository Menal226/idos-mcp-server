/**
 * Parsers for IDOS connection pages:
 *  - /{timetable}/spojeni/vysledky/?...    results, 3 connections per page
 *  - /{timetable}/spojeni/prehled/?p=..    one connection (same markup as one results box)
 *  - /{timetable}/spojeni/draha/?p=..      full route of one leg's vehicle
 * Times carry no date; IDOS only marks later-day times red. We instead roll the date forward whenever a time is
 * earlier than the previous one, which also works on the permalink page.
 */
import * as cheerio from "cheerio";
import type { Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";
import { clean } from "../common.js";

export interface Stop {
    name: string;
    time: string;
    datetime: string;
    platform?: string;
    notes?: string[];
}

export interface Leg {
    name: string;
    mode: string;
    route?: string;
    direction?: string;
    carrier?: string;
    departure: Stop;
    arrival: Stop;
    duration_minutes: number;
    walk_before?: string;
    delay_info?: string;
    delay_minutes?: number;
    features?: string[];
    route_url?: string;
}

export interface Connection {
    connection_id: string;
    url: string;
    departure: Stop;
    arrival: Stop;
    duration: string;
    duration_minutes: number;
    transfers: number;
    legs: Leg[];
    walk_after?: string;
}

export interface ResultsPage {
    connections: Connection[];
    fieldErrors: { field: "from" | "to" | "via"; message: string }[];
    noResultMessage?: string;
    validity?: { from: string; to: string };
}

export interface RouteStop {
    name: string;
    arrival?: string;
    departure?: string;
    datetime?: string;
    /** Counted from the vehicle's origin, not from where the passenger boards. */
    km?: number;
    platform?: string;
    /** false for stops before boarding / after alighting. */
    on_leg: boolean;
    notes?: string[];
}

export interface LegRoute {
    stops: RouteStop[];
    distance_km?: number;
    remarks: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");

function minutesOfDay(time: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** Turns HH:MM into ISO local datetimes, moving to the next day whenever a time goes backwards. */
class DayCursor {
    private date: Date;
    private last = -1;
    constructor(year: number, month: number, day: number) {
        this.date = new Date(Date.UTC(year, month - 1, day));
    }
    stamp(time: string): string {
        const mins = minutesOfDay(time);
        if (Number.isNaN(mins)) return "";
        if (this.last >= 0 && mins < this.last) this.date = new Date(this.date.getTime() + 86_400_000);
        this.last = mins;
        const d = this.date;
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    }
}

function diffMinutes(fromIso: string, toIso: string): number {
    const a = Date.parse(`${fromIso}:00Z`);
    const b = Date.parse(`${toIso}:00Z`);
    return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 60_000);
}

/** "2 hod 55 min", "1 den 3 hod", "45 min" -> minutes. */
function parseDurationText(text: string): number {
    const day = /(\d+)\s*(?:den|dny|dní|d\b)/.exec(text);
    const hour = /(\d+)\s*hod/.exec(text);
    const min = /(\d+)\s*min/.exec(text);
    return (day ? Number(day[1]) * 1440 : 0) + (hour ? Number(hour[1]) * 60 : 0) + (min ? Number(min[1]) : 0);
}

/** Year for a "D.M." date that puts it closest to the reference date. */
function inferYear(day: number, month: number, reference: Date): number {
    const refYear = reference.getUTCFullYear();
    let best = refYear;
    let bestDiff = Infinity;
    for (const y of [refYear - 1, refYear, refYear + 1]) {
        const diff = Math.abs(Date.UTC(y, month - 1, day) - reference.getTime());
        if (diff < bestDiff) {
            bestDiff = diff;
            best = y;
        }
    }
    return best;
}

const PLATFORM_TITLES = new Set(["nástupiště", "stanoviště", "kolej"]);
const IGNORED_NOTE_TITLES = new Set(["tar. pásmo", "Zobrazit detail spoje"]);

function stationExtras($: cheerio.CheerioAPI, scope: Cheerio<AnyNode>): { platform?: string; notes?: string[] } {
    let platform: string | undefined;
    const notes: string[] = [];
    scope.find("span[title]").each((_, el) => {
        const title = clean($(el).attr("title"));
        if (!title || IGNORED_NOTE_TITLES.has(title)) return;
        if (PLATFORM_TITLES.has(title)) platform ||= clean($(el).text()) || undefined;
        else if (!notes.includes(title)) notes.push(title);
    });
    return { ...(platform ? { platform } : {}), ...(notes.length ? { notes } : {}) };
}

function parseLeg($: cheerio.CheerioAPI, block: Cheerio<AnyNode>, cursor: DayCursor): Leg | undefined {
    const items = block.find("ul.stations > li.item");
    if (items.length < 2) return undefined;
    const title = block.find("a.title").first();
    const h3 = title.find("h3").first();
    // h3[title] is "mode (origin >> terminus)"
    const h3Title = clean(h3.attr("title"));
    const modeMatch = /^(.*?)\s*\((.*)\)\s*$/.exec(h3Title);
    const mode = modeMatch ? modeMatch[1] : h3Title;
    const route = modeMatch?.[2];
    const direction = route?.split(">>").pop()?.trim();

    const readStop = (li: Cheerio<AnyNode>): Stop => {
        const time = clean(li.find("p.time").first().text());
        return {
            name: clean(li.find("strong.name").first().text()),
            time,
            datetime: cursor.stamp(time),
            ...stationExtras($, li.find("p.station").first())
        };
    };
    const departure = readStop(items.first());
    const arrival = readStop(items.last());

    const carrier = clean(title.find(".owner").text());
    const walk = clean(block.children(".walk").text());
    const delayText = clean(block.find("a.delay-bubble").first().text());
    const liveDelay = /zpožděn\S*\s+(\d+)\s*min/i.exec(delayText);
    const features: string[] = [];
    title.find(".specs [title]").each((_, el) => {
        const t = clean($(el).attr("title"));
        if (t && !features.includes(t)) features.push(t);
    });
    const href = title.attr("href");

    return {
        name: clean(h3.text()),
        mode,
        ...(route ? { route } : {}),
        ...(direction ? { direction } : {}),
        ...(carrier ? { carrier } : {}),
        departure,
        arrival,
        duration_minutes: diffMinutes(departure.datetime, arrival.datetime),
        ...(walk ? { walk_before: walk } : {}),
        ...(delayText ? { delay_info: delayText } : {}),
        ...(liveDelay ? { delay_minutes: Number(liveDelay[1]) } : {}),
        ...(features.length ? { features } : {}),
        ...(href ? { route_url: href } : {})
    };
}

/** The `p` token of a prehled permalink. */
export function tokenFromPermalink(url: string): string | undefined {
    try {
        return new URL(url, "https://idos.cz").searchParams.get("p") ?? undefined;
    } catch {
        return undefined;
    }
}

function parseConnectionBox($: cheerio.CheerioAPI, box: Cheerio<AnyNode>, reference: Date): Connection | undefined {
    const shareUrl = box.attr("data-share-url") ?? "";
    const token = tokenFromPermalink(shareUrl);
    const h2 = box.find(".connection-head h2.date").first();
    const dateAfter = clean(h2.find(".date-after").text()); // "7.11. so"
    const startTime = clean(h2.clone().children().remove().end().text());
    const dm = /(\d{1,2})\.(\d{1,2})\./.exec(dateAfter);
    const day = dm ? Number(dm[1]) : reference.getUTCDate();
    const month = dm ? Number(dm[2]) : reference.getUTCMonth() + 1;
    const cursor = new DayCursor(inferYear(day, month, reference), month, day);
    if (startTime) cursor.stamp(startTime);

    const legs: Leg[] = [];
    let pendingWalk: string | undefined;
    box.find(".connection-details .outside-of-popup").each((_, el) => {
        const block = $(el);
        const leg = parseLeg($, block, cursor);
        if (leg) {
            if (!leg.walk_before && pendingWalk) leg.walk_before = pendingWalk;
            pendingWalk = undefined;
            legs.push(leg);
        } else {
            pendingWalk = clean(block.find(".walk").text()) || pendingWalk;
        }
    });
    // A walk to the final destination (e.g. an address) sits after the last leg, outside any leg block.
    let walkAfter = pendingWalk;
    box.find(".connection-details .walk").each((_, el) => {
        if ($(el).closest(".outside-of-popup").length === 0) walkAfter = clean($(el).text()) || walkAfter;
    });
    if (legs.length === 0 || !token) return undefined;

    const durationText = clean(box.find(".connection-head .total strong").first().text());
    const first = legs[0];
    const last = legs[legs.length - 1];
    return {
        connection_id: token,
        url: shareUrl,
        departure: first.departure,
        arrival: last.arrival,
        duration: durationText,
        duration_minutes: durationText ? parseDurationText(durationText) : diffMinutes(first.departure.datetime, last.arrival.datetime),
        transfers: legs.length - 1,
        legs,
        ...(walkAfter ? { walk_after: walkAfter } : {})
    };
}

/** Results page or single-connection permalink page. `reference` (the search date) supplies the year for "D.M." dates. */
export function parseResultsPage(html: string, reference: Date): ResultsPage {
    const $ = cheerio.load(html);
    const connections: Connection[] = [];
    $("div.box.connection[id^='connectionBox-']").each((_, el) => {
        const conn = parseConnectionBox($, $(el), reference);
        if (conn) connections.push(conn);
    });

    const fieldErrors: ResultsPage["fieldErrors"] = [];
    $("#connection-filter .inp-combined").each((_, el) => {
        const message = clean($(el).find(".label-error").text());
        if (!message) return;
        const inputId = $(el).find("input.inp-text").attr("id") ?? "";
        fieldErrors.push({ field: inputId === "From" ? "from" : inputId === "To" ? "to" : "via", message });
    });

    let noResultMessage: string | undefined;
    const modal = $("#errorModalContent");
    if (connections.length === 0 && modal.length) {
        const reasons = modal
            .find("li")
            .map((_, li) => clean($(li).text()))
            .get();
        const heading = clean(modal.find("b").first().text());
        const tail = clean(modal.clone().find("b, ul").remove().end().text()).replace(/^Možné příčiny:\s*/, "");
        noResultMessage = [heading, reasons.length ? `Possible causes: ${reasons.join(" ")}` : "", tail].filter(Boolean).join(" ").trim();
    }

    const v = /ConnFormParams\(new Date\('(\d+)\/(\d+)\/(\d{4})'\), new Date\('(\d+)\/(\d+)\/(\d{4})'\)/.exec(html);

    return {
        connections,
        fieldErrors,
        ...(noResultMessage ? { noResultMessage } : {}),
        ...(v ? { validity: { from: `${v[2]}.${v[1]}.${v[3]}`, to: `${v[5]}.${v[4]}.${v[6]}` } } : {})
    };
}

export function parseLegRoute(html: string): LegRoute {
    const $ = cheerio.load(html);
    const originDate = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(clean($(".line-top-date").first().text()));
    const cursor = originDate ? new DayCursor(Number(originDate[3]), Number(originDate[2]), Number(originDate[1])) : undefined;

    const stops: RouteStop[] = [];
    $("ul.line-itinerary > li.item").each((_, el) => {
        const li = $(el);
        const arrival = clean(li.children(".arrival").text()) || undefined;
        const departure = clean(li.children(".departure").text()) || undefined;
        const km = /^(\d+(?:[.,]\d+)?)\s*km/.exec(clean(li.children(".distance").text()));
        const arrStamp = cursor && arrival ? cursor.stamp(arrival) : undefined;
        const depStamp = cursor && departure ? cursor.stamp(departure) : undefined;
        const datetime = arrStamp ?? depStamp;
        stops.push({
            name: clean(li.children("strong.name").text()),
            ...(arrival ? { arrival } : {}),
            ...(departure ? { departure } : {}),
            ...(datetime ? { datetime } : {}),
            ...(km ? { km: Number(km[1].replace(",", ".")) } : {}),
            on_leg: !li.hasClass("inactive"),
            ...stationExtras($, li)
        });
    });

    const onLeg = stops.filter(s => s.on_leg);
    const firstKm = onLeg[0]?.km;
    const lastKm = onLeg.at(-1)?.km;
    const distance =
        onLeg.length >= 2 && firstKm !== undefined && lastKm !== undefined ? Math.round((lastKm - firstKm) * 10) / 10 : undefined;

    const remarks = $(".remarks-list__item")
        .map((_, el) => {
            const text = clean($(el).text());
            return clean($(el).find("img").first().attr("title")) === "Dopravce" ? `Dopravce: ${text}` : text;
        })
        .get()
        .filter(Boolean);

    return { stops, ...(distance !== undefined ? { distance_km: distance } : {}), remarks };
}
