import { readText } from "./state.ts";

export type Runner = "docker" | "local";

export interface Policy {
  schema: number;
  runner: Runner;
  cycle: {
    timeoutSec: number;
    defaultWakeMinutes: number;
    minWakeMinutes: number;
  };
  packet: { maxBytes: number };
  container: {
    image: string;
    memory: string;
    cpus: string;
    pidsLimit: number;
  };
}

export function defaultPolicy(): Policy {
  return {
    schema: 1,
    runner: "local",
    cycle: { timeoutSec: 1200, defaultWakeMinutes: 30, minWakeMinutes: 1 },
    packet: { maxBytes: 8192 },
    container: { image: "geng-agent:latest", memory: "2g", cpus: "1.5", pidsLimit: 512 },
  };
}

function num(v: unknown, path: string, min: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
    throw new Error(`policy: ${path} must be a number >= ${min}`);
  }
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`policy: ${path} must be a non-empty string`);
  }
  return v;
}

/**
 * Missing file -> defaults (init writes it). Present but malformed -> throw,
 * because a silent fallback would change behaviour behind your back.
 */
export function loadPolicy(file: string): Policy {
  const text = readText(file);
  if (text === null) return defaultPolicy();

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`policy: ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const p = raw as Partial<Policy>;
  const d = defaultPolicy();
  const runner = p.runner ?? d.runner;
  if (runner !== "docker" && runner !== "local") {
    throw new Error('policy: runner must be "docker" or "local"');
  }
  const cycle = p.cycle ?? d.cycle;
  const container = p.container ?? d.container;
  return {
    schema: p.schema ?? d.schema,
    runner,
    cycle: {
      timeoutSec: num(cycle.timeoutSec, "cycle.timeoutSec", 10),
      defaultWakeMinutes: num(cycle.defaultWakeMinutes, "cycle.defaultWakeMinutes", 1),
      minWakeMinutes: num(cycle.minWakeMinutes, "cycle.minWakeMinutes", 1),
    },
    packet: { maxBytes: num(p.packet?.maxBytes ?? d.packet.maxBytes, "packet.maxBytes", 512) },
    container: {
      image: str(container.image, "container.image"),
      memory: str(container.memory, "container.memory"),
      cpus: str(container.cpus, "container.cpus"),
      pidsLimit: num(container.pidsLimit, "container.pidsLimit", 16),
    },
  };
}
