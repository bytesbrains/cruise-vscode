import { describe, expect, it } from "vitest";
import {
  explainCompression,
  formatBytes,
  parseCompressHeader,
} from "../src/compression.ts";

describe("formatBytes", () => {
  it("formats small byte counts as exact B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("formats kilobytes with one decimal", () => {
    expect(formatBytes(1_000)).toBe("1.0 KB");
    expect(formatBytes(6_100)).toBe("6.1 KB");
    expect(formatBytes(18_200)).toBe("18.2 KB");
    expect(formatBytes(48_211)).toBe("48.2 KB");
  });

  it("formats megabytes and gigabytes", () => {
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(2_400_000_000)).toBe("2.4 GB");
  });
});

describe("parseCompressHeader", () => {
  it("returns null for missing, null, or empty header", () => {
    expect(parseCompressHeader(null)).toBeNull();
    expect(parseCompressHeader(undefined)).toBeNull();
    expect(parseCompressHeader("")).toBeNull();
    expect(parseCompressHeader("   ")).toBeNull();
  });

  it("parses applied header with version, before, and after", () => {
    const result = parseCompressHeader("applied v=1 before=48211 after=19307");
    expect(result).toEqual({
      status: "applied",
      version: 1,
      before: 48211,
      after: 19307,
    });
  });

  it("parses unchanged header", () => {
    const result = parseCompressHeader("unchanged v=1 before=3120 after=3120");
    expect(result).toEqual({
      status: "unchanged",
      version: 1,
      before: 3120,
      after: 3120,
    });
  });

  it("parses skipped header with reason", () => {
    expect(parseCompressHeader("skipped reason=no_tool_output")).toEqual({
      status: "skipped",
      reason: "no_tool_output",
    });
    expect(parseCompressHeader("skipped reason=error")).toEqual({
      status: "skipped",
      reason: "error",
    });
  });

  it("parses off header with various reasons", () => {
    expect(parseCompressHeader("off reason=mode_off")).toEqual({
      status: "off",
      reason: "mode_off",
    });
    expect(parseCompressHeader("off reason=project_off")).toEqual({
      status: "off",
      reason: "project_off",
    });
    expect(parseCompressHeader("off reason=header")).toEqual({
      status: "off",
      reason: "header",
    });
    expect(parseCompressHeader("off reason=conformance")).toEqual({
      status: "off",
      reason: "conformance",
    });
  });

  it("handles unknown or unrecognized formats gracefully", () => {
    expect(parseCompressHeader("something_unexpected foo=bar")).toEqual({
      status: "other",
      raw: "something_unexpected foo=bar",
    });
  });
});

describe("explainCompression", () => {
  it("explains applied compression with savings in status bar and log", () => {
    const parsed = parseCompressHeader("applied v=1 before=18200 after=6100")!;
    const explanation = explainCompression(parsed);
    expect(explanation.statusBarText).toBe("$(archive) compressed 18.2 KB → 6.1 KB");
    expect(explanation.statusBarTooltip).toContain("tool outputs in this turn were compressed");
    expect(explanation.statusBarTooltip).toContain("18.2 KB → 6.1 KB");
    expect(explanation.logMessage).toBe("request compression: tool outputs compressed (18.2 KB → 6.1 KB)");
  });

  it("logs unchanged compression but leaves status bar empty", () => {
    const parsed = parseCompressHeader("unchanged v=1 before=3120 after=3120")!;
    const explanation = explainCompression(parsed);
    expect(explanation.statusBarText).toBeNull();
    expect(explanation.logMessage).toBe("request compression: ran over tool outputs, unchanged (3.1 KB)");
  });

  it("logs skipped compression", () => {
    const parsed = parseCompressHeader("skipped reason=no_tool_output")!;
    const explanation = explainCompression(parsed);
    expect(explanation.statusBarText).toBeNull();
    expect(explanation.logMessage).toBe("request compression: skipped (no_tool_output)");
  });

  it("suppresses output entirely for off reason=project_off (the normal case)", () => {
    const parsed = parseCompressHeader("off reason=project_off")!;
    const explanation = explainCompression(parsed);
    expect(explanation.statusBarText).toBeNull();
    expect(explanation.logMessage).toBeNull();
  });

  it("logs other off reasons (e.g. mode_off, header)", () => {
    const parsed = parseCompressHeader("off reason=header")!;
    const explanation = explainCompression(parsed);
    expect(explanation.statusBarText).toBeNull();
    expect(explanation.logMessage).toBe("request compression: off (header)");
  });
});
