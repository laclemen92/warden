import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  API_VERSION,
  ActionError,
  type ActionsApi,
  type AnyActionDefinition,
  type RefSchema,
} from '@wardenhq/actions';
import { REF_KEYWORD, checkActionDefinitions, type ActionSpec } from '@wardenhq/core';
import { z } from 'zod';

/** The actions module (`WARDEN_ACTIONS`) is missing or invalid. Startup fails, like invalid config. */
export class ActionsError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`invalid actions module ${path}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ActionsError';
  }
}

export interface LoadedAction {
  spec: ActionSpec;
  definition: AnyActionDefinition;
}

/**
 * What Warden passes to an actions module. The module gets Warden's own zod, so Warden can read
 * its input schemas, and needs no packages of its own at runtime.
 */
export const actionsApi: ActionsApi = {
  apiVersion: API_VERSION,
  defineAction: (definition) => definition as AnyActionDefinition,
  z,
  // A record id on the wire; the server swaps in the loaded record before `run`.
  ref: (entity) =>
    z
      .string({ error: 'expected a record id' })
      .min(1, 'expected a record id')
      .max(10_000)
      .meta({ [REF_KEYWORD]: entity }) as unknown as RefSchema,
  ActionError,
};

/**
 * Load the actions module: an ES module whose default export is a function that returns the
 * deployment's actions. Loaded once at startup; every problem with it fails startup.
 */
export async function loadActions(file: string, cwd: string): Promise<LoadedAction[]> {
  const path = resolve(cwd, file);
  if (!existsSync(path)) throw new ActionsError(path, ['the file does not exist']);
  let mod: { default?: unknown; apiVersion?: unknown };
  try {
    mod = (await import(pathToFileURL(path).href)) as typeof mod;
  } catch (err) {
    throw new ActionsError(path, [
      `importing it failed: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  if (typeof mod.apiVersion === 'number' && Math.floor(mod.apiVersion) > API_VERSION) {
    throw new ActionsError(path, [
      `it was written for actions API ${mod.apiVersion}, but this Warden supports ${API_VERSION}`,
    ]);
  }
  if (typeof mod.default !== 'function') {
    throw new ActionsError(path, ['its default export must be a function that returns actions']);
  }
  let definitions: unknown;
  try {
    definitions = await (mod.default as (api: ActionsApi) => unknown)(actionsApi);
  } catch (err) {
    throw new ActionsError(path, [
      `its default export threw: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const checked = checkActionDefinitions(definitions);
  if (!checked.ok) throw new ActionsError(path, checked.errors);
  const list = definitions as AnyActionDefinition[];
  return checked.specs.map((spec, i) => ({ spec, definition: list[i]! }));
}
