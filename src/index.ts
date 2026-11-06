#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerConnectionTools } from "./tools/connections.js";
import { registerDepartureTools } from "./tools/departures.js";
import { registerLocationTools } from "./tools/locations.js";
import { registerTimetableTools } from "./tools/timetables.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

function createServer(): McpServer {
    const server = new McpServer(
        { name: "idos-mcp-server", version },
        {
            instructions:
                "Read-only access to IDOS.cz Czech public transport timetables (trains, buses, city transport). " +
                "Start with idos_search_locations to resolve place names, then idos_search_connections for journeys, " +
                "idos_get_departures for station boards, and the timetable tools for specific trains and city lines. " +
                "This server cannot buy tickets or access accounts."
        }
    );
    registerLocationTools(server);
    registerConnectionTools(server);
    registerDepartureTools(server);
    registerTimetableTools(server);
    return server;
}

serveStdio(createServer);
console.error(`idos-mcp-server ${version} running on stdio`);
