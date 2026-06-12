#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { resolveConfig } from "./config.js";
import { buildSavingsReport, loadEventsFromJsonl, renderCard, renderMarkdown } from "./report.js";
import { startServer } from "./server.js";

const program = new Command();

program
  .name("bildy")
  .description("Local-first LLM gateway for Claude Code, Codex, and future agent CLIs")
  .version("0.1.0");

program
  .command("start")
  .description("Start the local gateway server")
  .option("--port <port>", "Override port", (raw) => Number(raw))
  .option("--free", "Zero-dollar mode: route cheap classes to CF Workers AI free tier, disable shadow")
  .action(async (options) => {
    const freeMode = options.free ?? process.env.BILDY_FREE_MODE === "1";

    if (freeMode) {
      console.log([
        "",
        "  \x1b[36m\x1b[1mbildy zero-dollar mode\x1b[0m",
        "  cheap classes → @cf/meta/llama-3.3-70b-instruct-fp8-fast (CF free tier)",
        "  tool_loop + long_context stay on premium providers",
        "  CF free tier: ~10K neurons/day",
        "",
      ].join("\n"));
    }

    const config = resolveConfig({ port: options.port, freeMode });
    const server = await startServer(config);

    console.log(`bildy listening on http://localhost:${config.port}${freeMode ? " [zero-dollar mode]" : ""}`);

    const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
    const shutdown = () => {
      clearInterval(keepAlive);
      server.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await new Promise(() => {});
  });

program
  .command("report")
  .description("Show savings report from shadow-mode telemetry")
  .option("--share", "Output as markdown (for copy-paste or posting)")
  .option("--events <path>", "Path to events JSONL file (default: .bildy/gateway/events.sqlite.jsonl)")
  .action((options) => {
    const config = resolveConfig();
    const defaultJsonl = path.resolve(config.telemetry.path + ".jsonl");
    const jsonlPath = options.events ? path.resolve(options.events) : defaultJsonl;

    if (!existsSync(jsonlPath)) {
      console.error(`No telemetry found at ${jsonlPath}`);
      console.error("Start the gateway and run at least one session first.");
      process.exit(1);
    }

    const events = loadEventsFromJsonl(jsonlPath);
    const report = buildSavingsReport(events);

    if (options.share) {
      console.log(renderMarkdown(report));
    } else {
      console.log(renderCard(report));
    }
  });

await program.parseAsync(process.argv);
