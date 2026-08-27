import { EventEmitter } from "node:events";
import { redactDeep } from "../auth/redact.js";
import type { BaseEvent, EventType } from "./types.js";

export type EventListener = (event: BaseEvent) => void;

/**
 * In-process event bus. Every event passes through redaction before any
 * listener (persistence, stream renderer, tests) can observe it, so secrets
 * can never leak through events regardless of subscriber.
 */
export class EventBus {
  private emitter = new EventEmitter();
  private seq = 0;

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: Omit<BaseEvent, "seq" | "timestamp">): BaseEvent {
    const full: BaseEvent = {
      ...event,
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      data: redactDeep(event.data),
    };
    this.emitter.emit("event", full);
    return full;
  }

  onEvent(listener: EventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  onType(type: EventType, listener: EventListener): () => void {
    const wrapped: EventListener = (event) => {
      if (event.type === type) listener(event);
    };
    return this.onEvent(wrapped);
  }
}
