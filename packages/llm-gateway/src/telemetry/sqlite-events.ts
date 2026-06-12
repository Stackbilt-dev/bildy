import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { GatewayRequestEvent } from "../types.js";

export class JsonlEventSink {
  private readonly jsonlPath: string;

  constructor(filePath: string) {
    const absPath = path.resolve(filePath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.jsonlPath = `${absPath}.jsonl`;
  }

  write(event: GatewayRequestEvent): void {
    appendFileSync(this.jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  // Returns the last `limit` events from the JSONL file for replay into EventStore on startup.
  load(limit = 5000): GatewayRequestEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.jsonlPath, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    const events: GatewayRequestEvent[] = [];
    for (const line of tail) {
      try {
        events.push(JSON.parse(line) as GatewayRequestEvent);
      } catch { /* skip malformed lines */ }
    }
    return events;
  }
}
