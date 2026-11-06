[![npm](https://img.shields.io/npm/v/idos-mcp-server?style=flat-square)](https://www.npmjs.com/package/idos-mcp-server) [![License](https://img.shields.io/badge/license-Apache_2.0-blue?style=flat-square)](LICENSE)

# IDOS MCP Server

Lets AI assistants look up Czech public transport on [IDOS.cz](https://idos.cz/vlakyautobusymhdvse/spojeni/): journeys from A to B, departure and arrival boards with platforms and live delays, the route of a train by its number, and city-line timetables for Prague, Brno and about 90 other cities.

It is **read-only**. It can't buy tickets, make reservations, log in or create an account.

## Installation

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square)](https://insiders.vscode.dev/redirect/mcp/install?name=idos&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22idos-mcp-server%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square)](https://insiders.vscode.dev/redirect/mcp/install?name=idos&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22idos-mcp-server%22%5D%7D&quality=insiders) [![Install in Cursor](https://img.shields.io/badge/Cursor-Install_Server-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=idos&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImlkb3MtbWNwLXNlcnZlciJdfQ==) [![Download for Claude Desktop](https://img.shields.io/badge/Claude_Desktop-Download_Extension-D97757?style=flat-square&logo=claude&logoColor=white)](https://github.com/Menal226/idos-mcp-server/releases/latest/download/idos-mcp-server.mcpb)

### Prerequisites

[Node.js](https://nodejs.org) 20.3 or newer. The Claude Desktop extension doesn't need it, because Claude Desktop includes its own.

No account, API key or other setup is needed. The server runs locally and reads the public IDOS website.

### Claude Code

```bash
claude mcp add idos -- npx -y idos-mcp-server
```

### Claude Desktop

Download [idos-mcp-server.mcpb](https://github.com/Menal226/idos-mcp-server/releases/latest/download/idos-mcp-server.mcpb) and open it. Claude Desktop shows an install screen; there is nothing to fill in.

<details><summary>Or add it to the config file</summary>

Open **Settings → Developer → Edit Config**, add the server to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "idos": {
      "command": "npx",
      "args": ["-y", "idos-mcp-server"]
    }
  }
}
```

</details>

### VS Code

Use the install button above, or add this to `.vscode/mcp.json` or your user MCP configuration:

```json
{
  "servers": {
    "idos": {
      "command": "npx",
      "args": ["-y", "idos-mcp-server"]
    }
  }
}
```

### Cursor

Use the install button above, or add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "idos": {
      "command": "npx",
      "args": ["-y", "idos-mcp-server"]
    }
  }
}
```

### Other MCP hosts

Any host that supports local (stdio) MCP servers works. Configure it to run `npx -y idos-mcp-server`. Most hosts use the same JSON format as the Claude Desktop and Cursor examples above.

### Build from source

Clone this repository and run `npm install` and `npm run build`. Then use `node /path/to/idos-mcp-server/build/index.js` as the command in your host's config instead of `npx -y idos-mcp-server`.

### Check that it works

Ask your assistant: _"When is the next train from Praha hl.n. to Brno?"_ It should list connections with times, platforms and changes.

---

## Tools

Every tool also takes `response_format`: `markdown` (default) or `json` (string, optional). Dates are `YYYY-MM-DD` or Czech `D.M.YYYY`, times are `HH:MM`; leaving them out means today and now.

<details>

<summary><b>Places</b></summary>

- **idos_search_locations** - Find stations, stops and towns by (partial) name, with their type, region, transport modes and coordinates
  - `query`: Start of the name, e.g. `Brno`, `Praha hl`. Diacritics are optional (string, required)
  - `limit`: Maximum matches, 1–50, default 10 (number, optional)
  - `only_stations`: Only concrete stations and stops, not towns (boolean, optional)
  - `timetable`: Which timetables to search, see [Timetables](#timetables) (string, optional)

</details>

<details>

<summary><b>Journeys</b></summary>

- **idos_search_connections** - Plan a journey from A to B: departure and arrival times, changes, and each leg's train or line, carrier, platforms and delays
  - `from`, `to`: Start and destination, e.g. `Praha`, `Brno hl.n.`. A town means any stop in it (string, required unless `page_token` is given)
  - `via`: Up to 3 places to travel through (string[], optional)
  - `date`, `time`: When to travel (string, optional)
  - `arrival`: `true` makes `time` the latest arrival instead of the earliest departure (boolean, optional)
  - `only_direct`: Only connections without changes (boolean, optional)
  - `max_changes`: Maximum number of changes, 0–10 (number, optional)
  - `count`: How many connections to return, 1–15, default 5 (number, optional)
  - `page_token`: `next_page_token` or `prev_page_token` from a previous result, for later or earlier connections (string, optional)
  - `timetable`: Which timetables to search, see [Timetables](#timetables) (string, optional)

- **idos_get_connection_detail** - Every stop of a connection with arrival and departure times, platforms and km, plus the carrier's notes
  - `connection_id`: `connection_id` from `idos_search_connections`, or an IDOS connection link (string, required)
  - `include_full_route`: Also show the stops outside your part of each trip (boolean, optional)
  - `timetable`: Which timetables to search (string, optional)

</details>

<details>

<summary><b>Departure boards</b></summary>

- **idos_get_departures** - A station's departures or arrivals with platforms, carriers and live delays
  - `station`: A station or stop, e.g. `Praha hl.n.`, `Florenc`. If it's ambiguous, the error lists the exact names (string, required unless `page_token` is given)
  - `direction`: `departures` (default) or `arrivals` (string, optional)
  - `date`, `time`: When to start the board (string, optional)
  - `line`: Only this line, train or carrier, e.g. `R9`, `IC 500`, `207`, `Pendolino`, `Leo Express` (string, optional)
  - `destination`: Only services going to (or, for arrivals, coming from) or through this place, e.g. `Kolín` (string, optional)
  - `limit`: Maximum entries, 1–100, default 20 (number, optional)
  - `page_token`: `next_page_token` from a previous result, for later entries (string, optional)
  - `timetable`: Which timetables to search (string, optional)

- **idos_get_trip_route** - Every stop of one trip from a board, with times, platforms, km, tariff zones and the live position
  - `trip_id`: `trip_id` of an entry from `idos_get_departures` (string, required)

- **idos_get_train_route** - Find a train or long-distance bus by number or name at a station it leaves from, and show its whole route
  - `train`: e.g. `R 871`, `EC 171`, `871`, `Pendolino` (string, required)
  - `station`: A station where it departs, e.g. `Praha hl.n.` (string, required)
  - `date` (string, optional)
  - `time`: Roughly when it leaves that station. Much faster, and needed for trains late in the day at big stations (string, optional)
  - `timetable`: `vlaky` (trains, default), `autobusy` (long-distance buses) or `vlakyautobusymhdvse` (string, optional)
  - `max_pages`: How many board pages to scan, 1–15, default 6 (number, optional)

</details>

<details>

<summary><b>City lines</b></summary>

- **idos_list_city_timetables** - List the cities whose bus, tram, trolleybus and metro lines have stop timetables

- **idos_search_lines** - Find a city line and its route variants (first stop → last stop)
  - `city`: e.g. `Praha` (default), `Brno`, `Ostrava`, `Plzeň` (string, optional)
  - `query`: Line number, e.g. `136`, `22`, `A` (string, required)
  - `date` (string, optional)
  - `limit`: Maximum route variants, 1–50, default 20 (number, optional)

- **idos_get_line_route** - All stops of a city line in order, with travel minutes, tariff zones and stop attributes
  - `city` (string, optional)
  - `line`: e.g. `136`, `Tram 22` (string, required)
  - `direction`: Last stop of the route variant, e.g. `Jižní Město`. Defaults to the first variant (string, optional)
  - `date` (string, optional)

- **idos_get_stop_timetable** - The timetable of one line at one stop, by hour, for a date or the whole week
  - `city` (string, optional)
  - `line` (string, required)
  - `stop`: e.g. `Flora` (string, required)
  - `direction`: Any later stop on the line, usually the last one (string, optional)
  - `date` (string, optional)
  - `whole_week`: Workday, Saturday and Sunday tables instead of one date (boolean, optional)

</details>

### Timetables

Most tools take a `timetable` that picks which IDOS timetables to search. The default, `vlakyautobusymhdvse`, covers all trains, buses and city transport. Others include `vlaky` (trains only), `autobusy` (long-distance buses), `pid` (Prague) and `idsjmk` (South Moravia).

## Good to know

- **No ticket prices.** IDOS only shows prices through its ticket shop, which this server never opens.
- **Paging re-runs the search.** Results come with an opaque `page_token` for the next (or previous) page, and the server searches again from the last time shown.
- **Names are checked first.** Without that, IDOS quietly guesses, e.g. "Florenc" would become Florence in Italy. When a name is ambiguous, the tool lists the exact names to use.
- **Czech text stays Czech.** Notes, remarks and carrier information come straight from IDOS.
- **Be gentle.** Requests are spaced at least 250 ms apart. This server is meant for personal lookups, not bulk scraping.
- **The website can change.** IDOS has no public API, so the server reads its web pages. If CHAPS changes them, a tool may stop working until it's updated.

## Troubleshooting

| Message                                     | Fix                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| "'…' is ambiguous"                          | Use one of the exact names listed in the message, or look one up with `idos_search_locations`.                              |
| "IDOS knows no station or stop named …"     | Check the spelling, or search with fewer letters in `idos_search_locations`.                                                |
| "Timetable data covers … to …"              | The date is outside the published timetables. Pick a date in that range.                                                    |
| "No departure of '…' found at …"            | Pass `time` near the train's departure, check that it leaves (not just arrives at) that station, or raise `max_pages`.      |
| "IDOS rate limit hit" or "refused (HTTP 403)" | Wait a few minutes before trying again.                                                                                   |
| The tools don't appear                      | Restart your client and check that Node.js 20.3 or newer is installed (`node --version`).                                   |

Found a bug or want a feature? [Open an issue](https://github.com/Menal226/idos-mcp-server/issues).

## License

This project is licensed under the [Apache 2.0](LICENSE) license.
