import { readFileSync } from "node:fs";
import { GatewayRequestEvent, RouteClass } from "./types.js";

export interface DelegateLogEntry {
  ts: string;
  task: string;
  src: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  savedUsd: number;
  latencyMs: number;
}

export interface SavingsReport {
  generatedAt: string;
  totalRequests: number;
  reroutableRequests: number;
  reroutablePct: number;
  totalProjectedSavingsUsd: number;
  byRoute: Array<{ routeClass: RouteClass; count: number; projectedSavingsUsd: number }>;
  topProvider: string | null;
  shadowModeActive: boolean;
  dateRange: { from: string; to: string } | null;
  delegation: {
    calls: number;
    tokensIn: number;
    tokensOut: number;
    savedUsd: number;
    byTask: Array<{ task: string; count: number; tokensIn: number }>;
  } | null;
}

export function loadEventsFromJsonl(jsonlPath: string): GatewayRequestEvent[] {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return [];
  }
  const events: GatewayRequestEvent[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    try { events.push(JSON.parse(line) as GatewayRequestEvent); } catch { /* skip malformed */ }
  }
  return events;
}

export function loadDelegateLog(logPath: string): DelegateLogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const entries: DelegateLogEntry[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    try { entries.push(JSON.parse(line) as DelegateLogEntry); } catch { /* skip malformed */ }
  }
  return entries;
}

export function buildDelegationStats(entries: DelegateLogEntry[]): SavingsReport["delegation"] {
  if (entries.length === 0) return null;
  const byTaskMap = new Map<string, { count: number; tokensIn: number }>();
  let totalIn = 0, totalOut = 0, totalSaved = 0;
  for (const e of entries) {
    totalIn += e.tokensIn;
    totalOut += e.tokensOut;
    totalSaved += e.savedUsd;
    const t = byTaskMap.get(e.task) ?? { count: 0, tokensIn: 0 };
    t.count++;
    t.tokensIn += e.tokensIn;
    byTaskMap.set(e.task, t);
  }
  const byTask = [...byTaskMap.entries()]
    .map(([task, v]) => ({ task, ...v }))
    .sort((a, b) => b.tokensIn - a.tokensIn);
  return { calls: entries.length, tokensIn: totalIn, tokensOut: totalOut, savedUsd: totalSaved, byTask };
}

export function buildSavingsReport(events: GatewayRequestEvent[]): SavingsReport {
  const shadowed = events.filter((e) => e.shadowRoute !== undefined);
  const byRouteMap = new Map<RouteClass, { count: number; projectedSavingsUsd: number }>();
  const providerCount = new Map<string, number>();
  let totalProjected = 0;

  for (const e of shadowed) {
    const key = e.shadowRoute as RouteClass;
    const entry = byRouteMap.get(key) ?? { count: 0, projectedSavingsUsd: 0 };
    entry.count++;
    entry.projectedSavingsUsd += e.projectedSavingsUsd ?? 0;
    byRouteMap.set(key, entry);
    totalProjected += e.projectedSavingsUsd ?? 0;
    if (e.shadowProvider) {
      providerCount.set(e.shadowProvider, (providerCount.get(e.shadowProvider) ?? 0) + 1);
    }
  }

  const byRoute = [...byRouteMap.entries()]
    .map(([routeClass, v]) => ({ routeClass, ...v }))
    .sort((a, b) => b.projectedSavingsUsd - a.projectedSavingsUsd);

  const topProvider = [...providerCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const timestamps = events.map((e) => e.timestamp).filter(Boolean).sort();
  const dateRange = timestamps.length >= 2
    ? { from: timestamps[0], to: timestamps[timestamps.length - 1] }
    : null;

  const hasShadowMode = events.some((e) => e.shadowRoute !== undefined);

  return {
    generatedAt: new Date().toISOString(),
    totalRequests: events.length,
    reroutableRequests: shadowed.length,
    reroutablePct: events.length > 0 ? Math.round((shadowed.length / events.length) * 1000) / 10 : 0,
    totalProjectedSavingsUsd: Math.round(totalProjected * 100000) / 100000,
    byRoute,
    topProvider,
    shadowModeActive: hasShadowMode,
    dateRange,
    delegation: null,
  };
}

// ─── Terminal rendering ────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
};

function bar(count: number, max: number, width = 16): string {
  const filled = max > 0 ? Math.round((count / max) * width) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtUsd(usd: number): string {
  return usd < 0.001 ? "<$0.001" : `$${usd.toFixed(3)}`;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

export function renderCard(report: SavingsReport): string {
  const W = 58;
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  const line = (content = "") => `│ ${pad(content, W - 4)} │`;
  const div = `├${"─".repeat(W - 2)}┤`;
  const top = `┌${"─".repeat(W - 2)}┐`;
  const bot = `└${"─".repeat(W - 2)}┘`;

  const dateLabel = report.dateRange
    ? `${fmtDate(report.dateRange.from)} → ${fmtDate(report.dateRange.to)}`
    : "no data yet";

  const maxCount = Math.max(...report.byRoute.map((r) => r.count), 1);

  const rows: string[] = [
    top,
    line(`${C.cyan}${C.bold}  bildy savings report${C.reset}  ${C.dim}${dateLabel}${C.reset}`),
    div,
    line(`  ${C.bold}${report.totalRequests}${C.reset} total requests  ·  ${C.bold}${report.reroutableRequests}${C.reset} reroutable ${C.dim}(${report.reroutablePct}%)${C.reset}`),
    line(`  ${C.green}${C.bold}${fmtUsd(report.totalProjectedSavingsUsd)}${C.reset}${C.green} projected savings${C.reset}`),
  ];

  if (report.byRoute.length > 0) {
    rows.push(div);
    rows.push(line(`  ${C.dim}by route class${C.reset}`));
    for (const r of report.byRoute) {
      const b = bar(r.count, maxCount);
      const label = pad(r.routeClass, 12);
      rows.push(line(`  ${C.blue}${label}${C.reset}  ${C.dim}${b}${C.reset}  ${r.count} turns  ${C.dim}${fmtUsd(r.projectedSavingsUsd)}${C.reset}`));
    }
  }

  if (report.topProvider) {
    rows.push(div);
    rows.push(line(`  ${C.dim}top provider${C.reset}  ${C.yellow}${report.topProvider}${C.reset}`));
  }

  if (report.delegation) {
    const d = report.delegation;
    const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    rows.push(div);
    rows.push(line(`  ${C.dim}delegation (aegis-delegate)${C.reset}`));
    rows.push(line(`  ${C.bold}${d.calls}${C.reset} calls  ·  ${C.bold}${fmtTok(d.tokensIn)}${C.reset} tokens to CF  ·  ${C.green}${C.bold}${fmtUsd(d.savedUsd)}${C.reset}${C.green} saved${C.reset}`));
    for (const t of d.byTask.slice(0, 4)) {
      const b = bar(t.tokensIn, Math.max(...d.byTask.map((x) => x.tokensIn), 1));
      rows.push(line(`  ${C.blue}${pad(t.task, 10)}${C.reset}  ${C.dim}${b}${C.reset}  ${t.count}×  ${C.dim}${fmtTok(t.tokensIn)} in${C.reset}`));
    }
  } else if (!report.shadowModeActive) {
    rows.push(div);
    rows.push(line(`  ${C.dim}no delegation data — run ${C.reset}${C.bold}bildy free${C.reset}${C.dim} to track${C.reset}`));
  }

  if (report.shadowModeActive && !report.delegation) {
    rows.push(div);
    rows.push(line(`  ${C.dim}shadow mode on — gateway observing (no rerouting)${C.reset}`));
  }

  rows.push(bot);
  return rows.join("\n");
}

export function renderMarkdown(report: SavingsReport): string {
  const dateLabel = report.dateRange
    ? `${fmtDate(report.dateRange.from)} → ${fmtDate(report.dateRange.to)}`
    : "n/a";

  const tableRows = report.byRoute
    .map((r) => `| ${r.routeClass} | ${r.count} | ${fmtUsd(r.projectedSavingsUsd)} |`)
    .join("\n");

  return `## bildy savings report — ${dateLabel}

| metric | value |
|--------|-------|
| total requests | ${report.totalRequests} |
| reroutable | ${report.reroutableRequests} (${report.reroutablePct}%) |
| projected savings | ${fmtUsd(report.totalProjectedSavingsUsd)} |
| top provider | ${report.topProvider ?? "n/a"} |

### by route class

| route | turns | savings |
|-------|-------|---------|
${tableRows}

${report.shadowModeActive ? "_shadow mode active — run `bildy free` to capture these savings_" : "_routing live_"}

generated by [bildy](https://github.com/Stackbilt-dev/bildy)`;
}
