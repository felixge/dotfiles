import type { AgentSnapshot } from "./types.ts";

export interface BranchEntry {
	id: string;
}

export function branchEntryIds(entries: readonly BranchEntry[]): Set<string> {
	return new Set(entries.map((entry) => entry.id));
}

export function runsOnBranch(
	snapshots: readonly AgentSnapshot[],
	branchIds: ReadonlySet<string>,
): AgentSnapshot[] {
	return snapshots.filter((run) => branchIds.has(run.originEntryId));
}
