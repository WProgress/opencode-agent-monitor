import type { Snapshot } from "./state.ts";

export interface OverviewAgent {
  id: string;
  name: string;
  initials: string;
  tone: string;
  status: "working" | "sleeping";
  task: string;
}

export interface OverviewProject {
  id: string;
  name: string;
  path: string;
  working: number;
  sleeping: number;
  total: number;
  error: string | null;
  active: OverviewAgent[];
}

export interface Overview {
  generatedAt: number;
  projects: OverviewProject[];
  totals: { projects: number; working: number; sleeping: number; total: number };
  error?: string | null;
}

/** Turns one project snapshot into a compact card model for the overview. */
export function overviewProject(
  snapshot: Snapshot,
  fallback?: { id?: string; name?: string; path?: string },
): OverviewProject {
  const working = snapshot.desks.filter((desk) => desk.status === "working");
  return {
    id: snapshot.project.id || fallback?.id || "",
    name: snapshot.project.name || fallback?.name || "project",
    path: snapshot.project.path || fallback?.path || "",
    working: working.length,
    sleeping: snapshot.desks.length - working.length,
    total: snapshot.desks.length,
    error: snapshot.error,
    active: working.slice(0, 3).map((desk) => ({
      id: desk.id,
      name: desk.name,
      initials: desk.initials,
      tone: desk.tone,
      status: desk.status,
      task: desk.task,
    })),
  };
}

/** Active teams first, then alphabetical, so the overview reads as a priority list. */
export function buildOverview(projects: OverviewProject[], now = Date.now()): Overview {
  const sorted = [...projects].sort((left, right) => {
    const active = Number(right.working > 0) - Number(left.working > 0);
    if (active !== 0) return active;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  const working = sorted.reduce((total, project) => total + project.working, 0);
  const sleeping = sorted.reduce((total, project) => total + project.sleeping, 0);
  return {
    generatedAt: now,
    projects: sorted,
    totals: { projects: sorted.length, working, sleeping, total: working + sleeping },
  };
}
