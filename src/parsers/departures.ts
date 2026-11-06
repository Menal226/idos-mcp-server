// IDOS departures board (GET /{timetable}/odjezdy/vysledky/) and trip route (GET /{timetable}/Ajax/TrainDetail, JSONP
// whose `content` is an HTML fragment).
import * as cheerio from "cheerio";
import { clean, compact, encodeToken } from "../common.js";

interface RawFixedCode {
    sText: string | null;
    sTTText: string | null;
    sDesc: string | null;
}

interface RawRecord {
    oInfo: {
        aoFixedCodes: RawFixedCode[] | null;
        iTTIndex: number;
        iTrain: number;
        sNum1: string | null;
        sNum2: string | null;
        sType: string | null;
        sTypeName: string | null;
        sInfo: string | null;
        sIDSLine: string | null;
    } | null;
    asDirection: string[] | null;
    aoFixedCodes: RawFixedCode[] | null;
    sIDSLine: string | null;
    sTrack: string | null;
    sStand: string | null;
    sDestination: string | null;
    iDelay: number;
    sDelay: string | null;
    dtDateTime: string;
    sOwner: string | null;
    sText: string | null;
}

interface RawBoardModel {
    departureTableInfo: {
        oFromObjects: {
            oTimetableObject: {
                oItem: { iListID: number; sName: string } | null;
                sType: string | null;
                sRegion: string | null;
            } | null;
        } | null;
        aoRecords: RawRecord[] | null;
        sCombID: string | null;
    } | null;
    searchItem: {
        sCombId: string | null;
        oArrDep: { oUserInput: { oFrom: { sName: string; iListId: number } | null; bIsArr: boolean } | null } | null;
    } | null;
}

export interface BoardEntry {
    time: string;
    date: string;
    datetime: string;
    service: string;
    category: string;
    category_name?: string;
    number: string;
    train_name?: string;
    line?: string;
    carrier?: string;
    /** Destination for departures, origin for arrivals. */
    destination: string;
    via: string[];
    platform?: string;
    track?: string;
    delay_minutes?: number;
    realtime?: string;
    notes: string[];
    features: string[];
    trip_id: string;
    /** Row identity, used to de-duplicate entries when paging. */
    key: string;
}

export interface BoardPage {
    station: string;
    station_type?: string;
    station_region?: string;
    station_class?: number;
    is_arrivals: boolean;
    comb_id: string;
    entries: BoardEntry[];
}

export interface BoardError {
    error: string;
    validity?: { from: string; to: string };
}

/** Packed into trip_id. Short keys keep it compact: timetable, combination id, timetable index, train, date, time, station, arrivals. */
export interface TripHandle {
    tb: string;
    c: string;
    i: number;
    n: number;
    d: string;
    t: string;
    s: string;
    a: boolean;
}

function extractJsonAfter(text: string, marker: string): unknown {
    const start = text.indexOf(marker);
    if (start < 0) return undefined;
    let i = start + marker.length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "{") return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
            try {
                return JSON.parse(text.slice(i, j + 1));
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

const pad = (s: string) => s.padStart(2, "0");

function recordKey(record: RawRecord): string {
    return `${record.oInfo?.iTTIndex ?? -1}:${record.oInfo?.iTrain ?? -1}@${record.dtDateTime.slice(0, 16)}`;
}

/** Same key as `recordKey`, from a rendered row; data-datetime is "06.11.2026 19:59:00" or "07.11.2026 8:01:00". */
function rowKey(row: cheerio.Cheerio<any>): string {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2})/.exec(clean(row.attr("data-datetime")));
    const stamp = m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(m[4])}:${m[5]}` : "";
    return `${row.attr("data-ttindex") ?? -1}:${row.attr("data-train") ?? -1}@${stamp}`;
}

function codeTexts(codes: RawFixedCode[] | null | undefined): string[] {
    // Codes without sTTText are column hints (e.g. "tar. pásmo") without a value.
    return (codes ?? []).filter(code => code.sTTText && code.sDesc).map(code => clean(code.sDesc));
}

// The page embeds its full data model as JSON after this marker; the rendered table is used only for the service
// label and the live delay text.
const MODEL_MARKER = "new Dep.DepResult(params, null, ";

export function parseBoardPage(html: string, timetable: string): BoardPage | BoardError {
    const model = extractJsonAfter(html, MODEL_MARKER) as RawBoardModel | undefined;
    const $ = cheerio.load(html);

    if (!model?.departureTableInfo) {
        const messages = $(".label-error")
            .map((_, el) => clean($(el).text()))
            .get()
            .filter(Boolean);
        const v = /Dep\.DepFormParams\(new Date\('(\d+)\/(\d+)\/(\d+)'\), new Date\('(\d+)\/(\d+)\/(\d+)'\)/.exec(html);
        const validity = v ? { from: `${Number(v[2])}.${Number(v[1])}.${v[3]}`, to: `${Number(v[5])}.${Number(v[4])}.${v[6]}` } : undefined;
        return { error: messages.join(" "), ...(validity ? { validity } : {}) };
    }

    const labels = new Map<string, string>();
    const delays = new Map<string, string>();
    const collect = (selector: string, cell: string, into: Map<string, string>) =>
        $(selector).each((_, el) => {
            const row = $(el);
            const key = rowKey(row);
            const text = clean(row.find(cell).first().text());
            if (text && !into.has(key)) into.set(key, text);
        });
    collect("tr.dep-row-first", "span.code h3", labels);
    collect("tr.dep-row-second", "td.cell-delay", delays);

    const info = model.departureTableInfo;
    const userInput = model.searchItem?.oArrDep?.oUserInput;
    const tto = info.oFromObjects?.oTimetableObject;
    const station = userInput?.oFrom?.sName ?? tto?.oItem?.sName ?? "";
    const isArr = userInput?.bIsArr ?? false;
    const combId = model.searchItem?.sCombId ?? (info.sCombID ?? "").split("-")[0];

    const entries: BoardEntry[] = (info.aoRecords ?? []).map(record => {
        const o = record.oInfo;
        const key = recordKey(record);
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(record.dtDateTime);
        const date = m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : "";
        const time = m ? `${m[4]}:${m[5]}` : "";
        const category = clean(o?.sType);
        const number = clean(o?.sNum1);
        const num2 = clean(o?.sNum2);
        const line = clean(record.sIDSLine || o?.sIDSLine) || undefined;
        const plain = [category, number].filter(Boolean).join(" ");
        const delayText = delays.get(key);
        const notes = codeTexts(record.aoFixedCodes);
        if (record.sText) notes.push(clean(record.sText));
        if (o?.sInfo) notes.push(clean(o.sInfo));
        const handle: TripHandle = {
            tb: timetable,
            c: combId,
            i: o?.iTTIndex ?? -1,
            n: o?.iTrain ?? -1,
            d: date,
            t: time,
            s: station,
            a: isArr
        };
        return {
            time,
            date,
            datetime: record.dtDateTime,
            service: labels.get(key) ?? (line && line !== number ? `${line} (${plain})` : plain),
            category,
            ...(o?.sTypeName ? { category_name: clean(o.sTypeName) } : {}),
            number,
            // sNum2 is a train name for trains ("Vysočina") but a trip number for regional buses ("31").
            ...(num2 && !/^\d+$/.test(num2) ? { train_name: num2 } : {}),
            ...(line ? { line } : {}),
            ...(record.sOwner ? { carrier: clean(record.sOwner) } : {}),
            destination: clean(record.sDestination),
            via: (record.asDirection ?? []).map(name => clean(name)).filter(Boolean),
            ...(record.sStand ? { platform: clean(record.sStand) } : {}),
            ...(record.sTrack ? { track: clean(record.sTrack) } : {}),
            ...(record.iDelay >= 0 ? { delay_minutes: record.iDelay } : {}),
            ...(delayText || record.sDelay ? { realtime: delayText || clean(record.sDelay) } : {}),
            notes,
            features: codeTexts(o?.aoFixedCodes),
            trip_id: encodeToken(handle),
            key
        };
    });

    return {
        station,
        ...(tto?.sType ? { station_type: tto.sType } : {}),
        ...(tto?.sRegion ? { station_region: tto.sRegion } : {}),
        ...(tto?.oItem?.iListID ? { station_class: tto.oItem.iListID } : {}),
        is_arrivals: isArr,
        comb_id: combId,
        entries
    };
}

export interface TripStop {
    name: string;
    arrival?: string;
    departure?: string;
    platform?: string;
    tariff_zone?: string;
    distance_km?: number;
    notes: string[];
    before_selected_station: boolean;
    selected_station: boolean;
}

export interface TripRoute {
    service: string;
    category_name?: string;
    start_date?: string;
    stops: TripStop[];
    current_position?: string;
    position_after_stop?: string;
    remarks: string[];
    web_url?: string;
}

export function parseTripDetail(fragment: string, selectedStation: string): TripRoute {
    const $ = cheerio.load(fragment);
    const shareUrl = $("[id^=train-detail-]").first().attr("data-share-url");
    const h1 = $(".line-top h1").first();
    const startDate = clean($(".line-top .line-top-date strong").first().text());

    let currentPosition: string | undefined;
    let positionAfter: string | undefined;
    const selectedKey = compact(selectedStation);
    let selectedFound = false;

    const stops: TripStop[] = $("ul.line-itinerary > li.item")
        .map((_, el) => {
            const li = $(el);
            const name = clean(li.find("strong.name").first().text());
            const arrival = clean(li.find(".arrival").first().text());
            const departure = clean(li.find(".departure").first().text());
            const codes = li.find(".fixed-codes");
            const platform = clean(codes.find('span[title="nástupiště"]').first().text());
            const zone = clean(codes.find('span[title="tar. pásmo"]').first().text());
            const notes = new Set<string>();
            li.find(".wwwtt[title]").each((__, code) => {
                const title = clean($(code).attr("title"));
                if (title && !$(code).hasClass("tt-icon-position")) notes.add(title);
            });
            const distance = /^(\d+(?:[.,]\d+)?)\s*km/.exec(clean(li.find(".distance").first().text()));
            const position = li.find(".position a.text-position");
            if (position.length) {
                currentPosition = clean(position.text());
                positionAfter = name;
            }
            const selected = !selectedFound && compact(name) === selectedKey;
            if (selected) selectedFound = true;
            return {
                name,
                ...(arrival ? { arrival } : {}),
                ...(departure ? { departure } : {}),
                ...(platform ? { platform } : {}),
                ...(zone ? { tariff_zone: zone } : {}),
                ...(distance ? { distance_km: Number(distance[1].replace(",", ".")) } : {}),
                notes: [...notes],
                before_selected_station: li.hasClass("inactive"),
                selected_station: selected
            } satisfies TripStop;
        })
        .get();

    const remarks = $("ul.remarks-list > li")
        .map((_, el) => clean($(el).text()))
        .get()
        .filter(Boolean);

    return {
        service: clean(h1.text()),
        ...(h1.attr("title") ? { category_name: clean(h1.attr("title")) } : {}),
        ...(startDate ? { start_date: startDate } : {}),
        stops,
        ...(currentPosition ? { current_position: currentPosition, position_after_stop: positionAfter } : {}),
        remarks,
        ...(shareUrl && /^https:\/\/idos\.cz\//.test(shareUrl) ? { web_url: shareUrl } : {})
    };
}
