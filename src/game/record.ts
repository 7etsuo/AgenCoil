/**
 * The personal-best moment. A life is measured against the best it started
 * under; the first time its length passes that, the engine says so. A best
 * under the floor is not worth a moment, and a life that starts past its
 * record (a comeback, a full wisp bank) never "passes" it.
 */
export const RECORD_FLOOR = 50;

/** The best a life must beat for a moment, or 0 when there is nothing to beat. */
export function recordTarget(profileBest: number, localBest: number, spawnMass: number): number {
  const best = Math.max(profileBest, localBest);
  return best >= RECORD_FLOOR && spawnMass < best ? best : 0;
}
