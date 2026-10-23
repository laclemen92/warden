import { useCurrentUser, type CurrentUser } from './auth';
import { useCapabilities, type Capabilities } from './capabilities';

export const HELP_PATH = '/help';

/** Things a help section can depend on; a section is shown only when the user has one. */
export type HelpFeature =
  'create' | 'update' | 'delete' | 'export' | 'actions' | 'audit-log' | 'share-views';

/**
 * What the user can do on at least one table, from their capabilities and admin areas. Empty
 * until both load (or if either fails), so help for writes never shows to someone who can't.
 */
export function helpFeatures(
  capabilities: Capabilities | undefined,
  user: CurrentUser | undefined,
): Set<HelpFeature> {
  const features = new Set<HelpFeature>();
  if (!capabilities || !user) return features;
  for (const entity of Object.values(capabilities.entities)) {
    for (const action of entity.actions) {
      if (action === 'create' || action === 'update' || action === 'delete' || action === 'export')
        features.add(action);
    }
    if (entity.customActions?.length) features.add('actions');
  }
  if (user.admin?.includes('audit')) features.add('audit-log');
  if (user.admin?.includes('views')) features.add('share-views');
  return features;
}

export function useHelpFeatures(): Set<HelpFeature> {
  const { data: capabilities } = useCapabilities();
  const { data: user } = useCurrentUser();
  return helpFeatures(capabilities, user ?? undefined);
}

/** Whether a section needing any of `requires` (or nothing) shows. */
export function showsSection(
  features: ReadonlySet<HelpFeature>,
  requires: readonly HelpFeature[] | undefined,
): boolean {
  return !requires || requires.some((f) => features.has(f));
}
