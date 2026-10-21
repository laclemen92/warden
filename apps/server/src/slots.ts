/**
 * Counts work that holds a scarce resource (a database connection), overall and per user. The
 * returned function takes a slot, or returns undefined when a limit is reached; the release
 * function it gives back frees the slot once, however often it is called.
 */
export function createSlots({
  maxConcurrent,
  maxPerUser,
}: {
  maxConcurrent: number;
  maxPerUser: number;
}) {
  let running = 0;
  const perUser = new Map<string, number>();
  return (user: string): (() => void) | undefined => {
    const mine = perUser.get(user) ?? 0;
    if (running >= maxConcurrent || mine >= maxPerUser) return undefined;
    running++;
    perUser.set(user, mine + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      running--;
      const left = (perUser.get(user) ?? 1) - 1;
      if (left > 0) perUser.set(user, left);
      else perUser.delete(user);
    };
  };
}
