// Builds idos-mcp-server.mcpb for one-click install in Claude Desktop. Run `npm run build` first.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const stage = "bundle";

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
for (const file of ["build", "package.json", "package-lock.json", "LICENSE", "README.md"])
    cpSync(file, `${stage}/${file}`, { recursive: true });

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
writeFileSync(`${stage}/manifest.json`, JSON.stringify({ ...manifest, version }, null, 4));

execSync("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", { cwd: stage, stdio: "inherit" });
execSync(`npx -y @anthropic-ai/mcpb@2.1.2 pack ${stage} idos-mcp-server.mcpb`, { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
