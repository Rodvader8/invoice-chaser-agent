import { z } from "zod";
import type { Job } from "../domain.js";
import { Sm8Job } from "../standins/world.js";
import { getJson } from "./http.js";

export function toJob(raw: Sm8Job): Job {
  return {
    jobNumber: raw.generated_job_id,
    description: raw.job_description,
    status: raw.status,
    badges: raw.badges,
    notes: raw.notes,
  };
}

export interface JobsApi {
  listJobs(): Promise<Job[]>;
}

export class JobsClient implements JobsApi {
  constructor(private readonly baseUrl: string) {}

  async listJobs(): Promise<Job[]> {
    const raw = z.array(Sm8Job).parse(await getJson(`${this.baseUrl}/api_1.0/job.json`));
    return raw.map(toJob);
  }
}
