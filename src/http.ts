/**
 * The only network layer. Read-only by construction: GET requests only, to idos.cz only, and never to
 * ticket, purchase, payment, login, registration or account pages. Tools must not call `fetch` directly.
 */
import { BASE_URL, MIN_REQUEST_INTERVAL_MS, REQUEST_TIMEOUT_MS, USER_AGENT } from "./constants.js";

const BLOCKED_PATH =
    /(jizdenk|ticket|kosik|basket|cart|nakup|koupit|purchase|platb|payment|pay\/|ucet|account|login|logon|prihlas|registr|signup|sign-in|signin|logout|odhlas|profil|profile|order|objedn|rezerv|reserv|mojespojeni|favorite|oblibene|share|sdilet|email|delete)/i;

type Params = Record<string, string | number | boolean | undefined>;

export class IdosError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = "IdosError";
    }
}

function httpErrorMessage(status: number, path: string): string {
    switch (status) {
        case 400:
            return `IDOS rejected the request (HTTP 400) for ${path}. Check the station names, date (D.M.YYYY or YYYY-MM-DD) and time (HH:MM).`;
        case 403:
            return "IDOS refused the request (HTTP 403). The service may be blocking automated traffic; wait a few minutes and try again.";
        case 404:
            return `IDOS page not found (HTTP 404) for ${path}. The link may have expired; run the search again to get a fresh one.`;
        case 429:
            return "IDOS rate limit hit (HTTP 429). Wait a minute before making more requests.";
        default:
            return status >= 500
                ? `IDOS is having problems (HTTP ${status}). Try again in a moment.`
                : `IDOS returned HTTP ${status} for ${path}.`;
    }
}

/** Builds an absolute idos.cz URL, refusing other hosts and blocked paths. */
export function buildIdosUrl(pathOrUrl: string, params: Params = {}): URL {
    const url = new URL(pathOrUrl, BASE_URL);
    if (url.origin !== new URL(BASE_URL).origin) {
        throw new IdosError(`Refusing to request ${url.href}: only ${BASE_URL} is allowed.`);
    }
    if (BLOCKED_PATH.test(url.pathname)) {
        throw new IdosError(
            `Refusing to request ${url.pathname}: this server is read-only and never opens ticket, purchase, payment or account pages.`
        );
    }
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return url;
}

// Spaces requests out process-wide, to be polite to the site.
let nextSlot = 0;
async function throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + MIN_REQUEST_INTERVAL_MS;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

export async function idosGet(
    pathOrUrl: string,
    params: Params = {},
    { signal }: { signal?: AbortSignal } = {}
): Promise<{ body: string; url: string }> {
    const url = buildIdosUrl(pathOrUrl, params);
    await throttle();

    let response: Response;
    try {
        response = await fetch(url, {
            method: "GET",
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
                "Accept-Language": "cs,en;q=0.8"
            },
            signal: AbortSignal.any(signal ? [signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)] : [AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            throw new IdosError(`IDOS did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again, or narrow the query.`);
        }
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new IdosError(`Could not reach IDOS: ${error instanceof Error ? error.message : String(error)}`);
    }

    // A redirect must not land somewhere we would refuse to request directly.
    buildIdosUrl(response.url);
    if (!response.ok) throw new IdosError(httpErrorMessage(response.status, url.pathname), response.status);
    return { body: await response.text(), url: response.url };
}

/** GETs an IDOS AJAX endpoint, which answers JSONP (`cb(...)`), and parses the payload. */
export async function idosGetJsonp<T>(pathOrUrl: string, params: Params, options: { signal?: AbortSignal } = {}): Promise<T> {
    const { body } = await idosGet(pathOrUrl, { ...params, callback: "cb" }, options);
    const match = /^\s*cb\(([\s\S]*)\)\s*;?\s*$/.exec(body);
    try {
        return JSON.parse(match ? match[1] : body) as T;
    } catch {
        throw new IdosError("IDOS returned an unexpected response (not JSON). The site may have changed; try again later.");
    }
}
