import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GuardAuditRecord } from "./guard.js";

export const COMMAND_GUARD_AUDIT_ENTRY_TYPE = "command-guard-audit";
export const COMMAND_GUARD_AUDIT_VERSION = 1;

const ANALYZER_SOURCES = ["guard.ts", "paths.ts", "rules.ts", "shell.ts"] as const;

export interface CommandGuardAuditEntry extends GuardAuditRecord {
  version: typeof COMMAND_GUARD_AUDIT_VERSION;
  analyzerHash: string;
  toolCallId: string;
}

export function commandGuardAnalyzerHash(): string {
  try {
    const hash = createHash("sha256");
    for (const source of ANALYZER_SOURCES) {
      hash.update(source);
      hash.update("\0");
      hash.update(readFileSync(fileURLToPath(new URL(source, import.meta.url))));
      hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return "unavailable";
  }
}
