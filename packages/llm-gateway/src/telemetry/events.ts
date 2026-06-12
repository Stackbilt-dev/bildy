import { GatewayRequestEvent } from "../types.js";

export class EventStore {
  private readonly events: GatewayRequestEvent[] = [];

  append(event: GatewayRequestEvent): void {
    this.events.push(event);
    if (this.events.length > 5000) this.events.shift();
  }

  recent(limit = 100, evalRunId?: string): GatewayRequestEvent[] {
    const events = evalRunId ? this.events.filter((event) => event.evalRunId === evalRunId) : this.events;
    return events.slice(-limit).reverse();
  }

  all(evalRunId?: string): GatewayRequestEvent[] {
    const events = evalRunId ? this.events.filter((event) => event.evalRunId === evalRunId) : this.events;
    return [...events];
  }
}
