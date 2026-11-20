import { listen, sendJson, type RunningServer } from "./http.js";
import type { Sm8Job } from "./world.js";

/** A stand-in for a ServiceM8-like job system, written for this repo, in memory, read only. */
export class JobsStandIn {
  private readonly jobs: Sm8Job[];

  constructor(jobs: Sm8Job[]) {
    this.jobs = structuredClone(jobs);
  }

  start(port = 0): Promise<RunningServer> {
    return listen((req, res, url) => {
      if (req.method !== "GET") return sendJson(res, 405, { error: "read only" });
      if (url.pathname === "/api_1.0/job.json") return sendJson(res, 200, this.jobs);
      const match = /^\/api_1\.0\/job\/([\w-]+)\.json$/.exec(url.pathname);
      const job = match ? this.jobs.find((j) => j.uuid === match[1]) : undefined;
      return job ? sendJson(res, 200, job) : sendJson(res, 404, {});
    }, port);
  }
}
