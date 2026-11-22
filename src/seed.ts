import { z } from "zod";
import { World } from "./standins/world.js";
import seedJson from "./seed.json" with { type: "json" };

/** The invented demo data the stand-ins serve (imported, so it's bundled into the Lambda too). */
export const Seed = World.extend({ asOf: z.string() });
export type Seed = z.infer<typeof Seed>;

export function loadSeed(): Seed {
  return Seed.parse(seedJson);
}
