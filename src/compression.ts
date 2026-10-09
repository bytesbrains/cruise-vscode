/**
 * Formatting and parsing for the `x-cruise-compress` header contract (#35).
 *
 * Cruise compresses tool outputs on the gateway before the request reaches
 * the upstream provider (bytesbrains-cruise#593, shipped in #600).
 *
 * The gateway responds with `x-cruise-compress` following the grammar:
 * a first word (applied | unchanged | skipped | off), then key=value pairs:
 *
 * - applied v=1 before=<bytes> after=<bytes>
 * - unchanged v=1 before=<bytes> after=<bytes>
 * - skipped reason=no_tool_output | error
 * - off reason=mode_off | project_off | header | conformance
 *
 * On request: `x-cruise-compress: off` opts that request out. Any other value
 * is a 400 invalid_compress_header from the gateway.
 */

export interface CompressionApplied {
  readonly status: "applied";
  readonly version: number | null;
  readonly before: number;
  readonly after: number;
}

export interface CompressionUnchanged {
  readonly status: "unchanged";
  readonly version: number | null;
  readonly before: number;
  readonly after: number;
}

export interface CompressionSkipped {
  readonly status: "skipped";
  readonly reason: string;
}

export interface CompressionOff {
  readonly status: "off";
  readonly reason: string;
}

export interface CompressionOther {
  readonly status: "other";
  readonly raw: string;
}

export type CompressionHeader =
  | CompressionApplied
  | CompressionUnchanged
  | CompressionSkipped
  | CompressionOff
  | CompressionOther;

/** Parse `x-cruise-compress` response header into a typed structure. */
export function parseCompressHeader(header: string | null | undefined): CompressionHeader | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  const [firstWord, ...parts] = trimmed.split(/\s+/);
  const params = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq !== -1) {
      params.set(part.slice(0, eq), part.slice(eq + 1));
    }
  }

  const parseNumber = (key: string): number | null => {
    const raw = params.get(key);
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  if (firstWord === "applied" || firstWord === "unchanged") {
    const before = parseNumber("before");
    const after = parseNumber("after");
    const version = parseNumber("v");
    if (before !== null && after !== null) {
      return firstWord === "applied"
        ? { status: "applied", version, before, after }
        : { status: "unchanged", version, before, after };
    }
  }

  if (firstWord === "skipped") {
    const reason = params.get("reason") ?? "unknown";
    return { status: "skipped", reason };
  }

  if (firstWord === "off") {
    const reason = params.get("reason") ?? "unknown";
    return { status: "off", reason };
  }

  return { status: "other", raw: trimmed };
}

/** Formats byte counts into human-readable strings (e.g. 18.2 KB, 6.1 KB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
  const val = bytes / Math.pow(1000, i);
  // Format with one decimal place, e.g. 18.2 KB
  return `${val.toFixed(1)} ${units[i]}`;
}

/**
 * Build a concise summary sentence for display in the status bar or log.
 * Returns null if nothing should be shown (e.g. `off reason=project_off`,
 * which is the normal case for most users).
 */
export function explainCompression(info: CompressionHeader): {
  logMessage: string | null;
  statusBarText: string | null;
  statusBarTooltip: string | null;
} {
  switch (info.status) {
    case "applied": {
      const beforeStr = formatBytes(info.before);
      const afterStr = formatBytes(info.after);
      const text = `compressed ${beforeStr} → ${afterStr}`;
      return {
        logMessage: `request compression: tool outputs compressed (${beforeStr} → ${afterStr})`,
        statusBarText: `$(archive) ${text}`,
        statusBarTooltip: `Cruise request compression: tool outputs in this turn were compressed (${beforeStr} → ${afterStr}). Click to toggle.`,
      };
    }
    case "unchanged": {
      const sizeStr = formatBytes(info.before);
      return {
        logMessage: `request compression: ran over tool outputs, unchanged (${sizeStr})`,
        statusBarText: null,
        statusBarTooltip: null,
      };
    }
    case "skipped": {
      return {
        logMessage: `request compression: skipped (${info.reason})`,
        statusBarText: null,
        statusBarTooltip: null,
      };
    }
    case "off": {
      // Don't log or show status bar for project_off, as that's the normal default.
      if (info.reason === "project_off") {
        return {
          logMessage: null,
          statusBarText: null,
          statusBarTooltip: null,
        };
      }
      return {
        logMessage: `request compression: off (${info.reason})`,
        statusBarText: null,
        statusBarTooltip: null,
      };
    }
    case "other": {
      return {
        logMessage: `request compression: ${info.raw}`,
        statusBarText: null,
        statusBarTooltip: null,
      };
    }
  }
}
