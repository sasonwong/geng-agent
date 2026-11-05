import { ExpectedError } from "./errors.ts";
import { readText } from "./fs.ts";

export interface Policy {
  schema: number;
  cycle: {
    timeoutSec: number;
    defaultWakeMinutes: number;
    minWakeMinutes: number;
    /** Identical tool + args this many times counts as "stuck". */
    repeatThreshold: number;
  };
  /** Off if you don't want snapshots; also skipped automatically when rustic or its password is missing. */
  backup: { enabled: boolean };
  /** The container's clock. The page shows UTC and this, so the two never disagree. */
  timezone: string;
  /** What arrives from people does not accumulate forever. */
  files: {
    /** 0 clears nothing by age: the size cap then governs alone. */
    maxAgeDays: number;
    maxMb: number;
  };
  container: {
    image: string;
    memory: string;
    cpus: string;
    pidsLimit: number;
    /**
     * How the daemon reaches the outside world itself: "auto" (its own environment),
     * "off" (direct, even if the environment says otherwise), or a proxy URL
     * (`http://`, `socks5://`, with optional user:pass).
     */
    proxyChain: string;
    /**
     * Host names the proxy may reach. `["*"]` is every name; a `!` prefix excludes one.
     * Deny always wins, whatever the order.
     */
    proxyAllow: string[];
    /**
     * Addresses the proxy may reach, after the name is resolved. Same `!` syntax. The
     * default is every address except the private, loopback and link-local ranges — those
     * are written out rather than assumed, so opening one is a line somebody deleted.
     */
    proxyAllowCidrs: string[];
  };
}

export function defaultPolicy(): Policy {
  return {
    schema: 1,
    cycle: { timeoutSec: 1800, defaultWakeMinutes: 30, minWakeMinutes: 1, repeatThreshold: 3 },
    backup: { enabled: true },
    timezone: "Asia/Shanghai",
    files: { maxAgeDays: 0, maxMb: 500 },
    container: {
      image: "geng-agent:latest",
      memory: "2g",
      cpus: "1.5",
      pidsLimit: 512,
      proxyChain: "auto",
      proxyAllow: ["*"],
      // `0.0.0.0/0` minus the ranges that are not "the internet". Written as data, not as a
      // rule in code: to let it reach a private network, delete the line — and then it is
      // in the diff.
      proxyAllowCidrs: [
        "0.0.0.0/0",
        "::/0",
        "!0.0.0.0/8",
        "!10.0.0.0/8",
        "!100.64.0.0/10",
        "!127.0.0.0/8",
        "!169.254.0.0/16",
        "!172.16.0.0/12",
        "!192.168.0.0/16",
        "!::1/128",
        "!fc00::/7",
        "!fe80::/10",
      ],
    },
  };
}

function num(v: unknown, path: string, min: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
    throw new ExpectedError(`policy: ${path} must be a number >= ${min}`);
  }
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ExpectedError(`policy: ${path} must be a non-empty string`);
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
    throw new ExpectedError(`policy: ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const p = raw as Partial<Policy>;
  const d = defaultPolicy();
  const cycle = p.cycle ?? d.cycle;
  const container = p.container ?? d.container;
  return {
    schema: p.schema ?? d.schema,
    cycle: {
      timeoutSec: num(cycle.timeoutSec, "cycle.timeoutSec", 10),
      defaultWakeMinutes: num(cycle.defaultWakeMinutes, "cycle.defaultWakeMinutes", 1),
      minWakeMinutes: num(cycle.minWakeMinutes, "cycle.minWakeMinutes", 1),
      repeatThreshold: num(cycle.repeatThreshold ?? d.cycle.repeatThreshold, "cycle.repeatThreshold", 2),
    },
    backup: { enabled: p.backup?.enabled !== false },
    timezone: str(p.timezone ?? d.timezone, "timezone"),
    files: {
      maxAgeDays: num(p.files?.maxAgeDays ?? d.files.maxAgeDays, "files.maxAgeDays", 0),
      maxMb: num(p.files?.maxMb ?? d.files.maxMb, "files.maxMb", 1),
    },
    container: {
      image: str(container.image, "container.image"),
      memory: str(container.memory, "container.memory"),
      cpus: str(container.cpus, "container.cpus"),
      pidsLimit: num(container.pidsLimit, "container.pidsLimit", 16),
      proxyChain: (() => {
        const raw = typeof container.proxyChain === "string" ? container.proxyChain.trim() : d.container.proxyChain;
        if (raw === "" || raw === "auto" || raw === "off") return raw === "" ? "auto" : raw;
        if (!/^(https?|socks5h?):\/\//.test(raw)) {
          throw new ExpectedError(`policy: container.proxyChain 要是 auto、off 或 http(s)/socks5 URL，收到 ${raw}`);
        }
        return raw;
      })(),
      proxyAllow:
        container.proxyAllow === undefined
          ? d.container.proxyAllow
          : (() => {
              // A wildcard here would be an open proxy on the host; direct network is what
              // "let it go anywhere" already means, and it is a different field with a
              // different consequence.
              const list = Array.isArray(container.proxyAllow) ? container.proxyAllow : [];
              if (list.some((x) => String(x).replace(/^!/, "").includes("/") || String(x).replace(/^!/, "").includes(":"))) {
                throw new ExpectedError("policy: container.proxyAllow 只收主机名（\"*\" 表示全部，\"!name\" 排除），不收网段、URL 或端口");
              }
              return list.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
            })(),
      proxyAllowCidrs:
        container.proxyAllowCidrs === undefined
          ? d.container.proxyAllowCidrs
          : (() => {
              const list = Array.isArray(container.proxyAllowCidrs) ? container.proxyAllowCidrs : [];
              return list
                .filter((x): x is string => typeof x === "string" && x.trim() !== "")
                .map((x) => x.trim())
                .map((entry) => {
                  const body = entry.startsWith("!") ? entry.slice(1) : entry;
                  // A name here would never match an address, and the silence would look
                  // like the proxy ignoring the rule.
                  // a bare word (no slash, no dot, no colon) is a host name, not an address
                  const bare = !body.includes("/") && !body.includes(".") && !body.includes(":");
                  if (bare || !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(body)) {
                    throw new ExpectedError(`policy: container.proxyAllowCidrs 只收网段或地址，收到 ${entry}`);
                  }
                  return entry;
                });
            })(),
    },
  };
}

/** Every dotted key in a policy object, so two of them can be compared leaf by leaf. */
function keysOf(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    keysOf(v, prefix === "" ? k : `${prefix}.${k}`),
  );
}

const TRAILER = ".schema";

/**
 * What the template says that this copy does not, and what the copy carries that nothing
 * reads any more.
 *
 * The copy is made once by `init` and never follows the template, so a new default (or a
 * removed field) changes behaviour silently: the instance keeps working and means something
 * else. This is the only place that can say so, because it is the only place holding both
 * files.
 */
export function policyDrift(
  template: Record<string, unknown>,
  instance: Record<string, unknown>,
): { missing: string[]; stale: string[] } {
  const want = new Set(keysOf(template).filter((k) => !k.endsWith(TRAILER)));
  const have = new Set(keysOf(instance).filter((k) => !k.endsWith(TRAILER)));
  return {
    missing: [...want].filter((k) => !have.has(k)).sort(),
    stale: [...have].filter((k) => !want.has(k)).sort(),
  };
}

/** The value a missing key would take, read from the template — the drift message's point. */
export function templateValue(template: Record<string, unknown>, key: string): unknown {
  let node: unknown = template;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
