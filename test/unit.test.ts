import { describe, expect, it } from "vitest";
import { compact, decodeToken, encodeToken, fitToLimit, fold, largestFittingCount, toIdosDate } from "../src/common.js";
import { CHARACTER_LIMIT } from "../src/constants.js";
import { buildIdosUrl, IdosError } from "../src/http.js";
import { parseStopTimetable } from "../src/parsers/timetables.js";

describe("read-only URL guard", () => {
    it.each([
        "/vlakyautobusymhdvse/jizdenky/",
        "/vlakyautobusymhdvse/spojeni/mojespojeni/?h=0",
        "/Account/Login",
        "/vlakyautobusymhdvse/kosik/",
        "/vlakyautobusymhdvse/Ajax/Ticket/Buy",
        "/vlakyautobusymhdvse/registrace/",
        "/vlakyautobusymhdvse/spojeni/ShareByEmail/"
    ])("refuses %s", path => {
        expect(() => buildIdosUrl(path)).toThrow(IdosError);
    });

    it("refuses other hosts", () => {
        expect(() => buildIdosUrl("https://example.com/vlakyautobusymhdvse/spojeni/")).toThrow(IdosError);
        expect(() => buildIdosUrl("//evil.example/vlaky/")).toThrow(IdosError);
    });

    it("allows timetable pages and drops empty params", () => {
        const url = buildIdosUrl("/vlakyautobusymhdvse/spojeni/vysledky/", { f: "Praha", t: "Brno", time: undefined, date: "" });
        expect(url.href).toBe("https://idos.cz/vlakyautobusymhdvse/spojeni/vysledky/?f=Praha&t=Brno");
    });
});

describe("stop timetable parser", () => {
    it("reads interval hours as a headway, not as departures", () => {
        const html = `
            <div class="zjr-panel"><h2 class="departures__title">Linka Tram 4</h2></div>
            <div class="zjr-stations"><table class="zjr-table"><tbody>
                <tr><td class="zjr-table__station_name"><span class="bold">Zoologická zahrada</span></td><td class="zjr-table__time"></td><td class="tarif">P</td></tr>
            </tbody></table></div>
            <div class="zjr-tables-wrap"><table class="zjr-table times"><thead><tr><th></th><th>25.11.2026 Středa</th></tr></thead><tbody>
                <tr><td>5</td><td>03B 09B 13</td></tr>
                <tr><td>6</td><td>01 int. 3-4 min.</td></tr>
            </tbody></table></div>`;
        const hours = parseStopTimetable(html)?.tables[0].hours;
        expect(hours).toEqual([
            {
                hour: 5,
                departures: [
                    { minute: 3, marks: "B" },
                    { minute: 9, marks: "B" },
                    { minute: 13, marks: "" }
                ]
            },
            { hour: 6, departures: [{ minute: 1, marks: "" }], interval_minutes: "3-4" }
        ]);
    });
});

describe("helpers", () => {
    it("converts dates to the IDOS format", () => {
        expect(toIdosDate("2026-11-07")).toBe("7.11.2026");
        expect(toIdosDate("07. 11. 2026")).toBe("07.11.2026");
        expect(toIdosDate(undefined)).toBeUndefined();
    });

    it("folds names for comparison", () => {
        expect(fold("  České   Budějovice ")).toBe("ceske budejovice");
        expect(compact("Brno, ÚAN Zvonařka")).toBe("brnouanzvonarka");
    });

    it("round-trips tokens and rejects garbage", () => {
        const token = encodeToken({ s: "Praha hl.n.", k: [1, 2] });
        expect(decodeToken(token)).toEqual({ s: "Praha hl.n.", k: [1, 2] });
        expect(decodeToken("%%%")).toBeUndefined();
    });

    it("keeps as many items as fit in the character limit", () => {
        const items = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(1000, "x"));
        const { text, shown } = fitToLimit(items, list => list.join("\n"));
        expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
        expect(shown).toBe(24);
        expect(largestFittingCount(0, () => "")).toBe(0);
        expect(largestFittingCount(3, n => "x".repeat(n * CHARACTER_LIMIT))).toBe(1);
    });
});
