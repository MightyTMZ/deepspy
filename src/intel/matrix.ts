import type { Storage } from "@periscope/knowledge";

/** One chosen run per competitor: never silently blend historical findings. */
export function comparisonMatrix(storage: Storage, runIds: string[]) {
  const latest = new Map<string, string>();
  for (const runId of [...new Set(runIds)].sort((a, b) => (storage.getRun(a)?.createdAt ?? "").localeCompare(storage.getRun(b)?.createdAt ?? ""))) {
    for (const job of storage.getJobsByRun(runId)) if (job.competitor) latest.set(job.competitor, runId);
  }
  const findings = [...latest].flatMap(([competitor, runId]) => storage.getFindingsByRun(runId, "feature").filter((f) => f.competitor === competitor));
  const rows = findings.map((f) => ({ id: f.id, runId: f.runId, competitor: f.competitor, feature: f.title ?? "", status: f.value?.startsWith("absent:") ? "absent" : f.status, value: f.value, evidence: f.observationIds }));
  const competitors = [...latest.keys()].sort();
  const features = [...new Set(rows.map((f) => f.feature))].sort();
  return {
    rows, selectedRuns: Object.fromEntries(latest),
    grid: { competitors, features, cells: features.map((feature) => ({ feature, byCompetitor: Object.fromEntries(competitors.map((co) => [co, rows.find((r) => r.feature === feature && r.competitor === co) ?? null])) })) },
    note: findings.length ? undefined : "No extracted findings yet. Extract the selected runs to populate the comparison.",
  };
}
