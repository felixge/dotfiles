import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeCommand, localExecutionContext } from "../shell.js";
import { matchingRules } from "../rules.js";

export interface TestFs {
  root: string;
  cwd: string;
  home: string;
  external: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export function testFs(): TestFs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "command-guard-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  const external = path.join(root, "external");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  fs.mkdirSync(external);
  return {
    root,
    cwd,
    home,
    external,
    env: { HOME: home, TMPDIR: os.tmpdir(), PWD: cwd },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function matchNames(command: string, fixture: TestFs): string[] {
  const analysis = analyzeCommand(command, localExecutionContext(fixture.cwd, fixture.env));
  return matchingRules({ analysis }).map((rule) => rule.name);
}
