import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isMap, isScalar, LineCounter, parseDocument, type Document, type Node } from 'yaml';
import type { z } from 'zod';
import { wardenConfigSchema, type WardenConfig } from './schema.js';

/** Searched for, in order, in the working directory when no path is given. */
export const CONFIG_FILE_NAMES = ['warden.config.yaml', 'warden.config.yml', 'warden.config.json'];

export interface ConfigIssue {
  /** Dotted key path, e.g. `tables.users.columns.email.hidden`. Empty for the document root. */
  path: string;
  message: string;
  line?: number;
  column?: number;
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly issues: ConfigIssue[],
  ) {
    const lines = issues.map((i) => {
      const where = i.line ? ` (line ${i.line}, col ${i.column})` : '';
      return `  - ${i.path || '<root>'}${where}: ${i.message}`;
    });
    super(`Invalid Warden config ${file}:\n${lines.join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  /** Explicit config path. Takes precedence over `WARDEN_CONFIG`. */
  path?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface LoadedConfig {
  config: WardenConfig;
  /** Absolute path of the file that was loaded, or `null` when running on defaults. */
  path: string | null;
}

/**
 * Load the Warden config.
 *
 * Resolution: `options.path`, then `WARDEN_CONFIG`, then the first of {@link CONFIG_FILE_NAMES}
 * in `cwd`. An explicitly named file must exist; when nothing is found, defaults are used
 * (expose everything, read-only).
 */
export async function loadConfig({
  path,
  cwd = process.cwd(),
  env = process.env,
}: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const explicit = path ?? env.WARDEN_CONFIG;
  if (explicit) {
    const file = resolve(cwd, explicit);
    const source = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      throw new ConfigError(file, [
        { path: '', message: err.code === 'ENOENT' ? 'File not found' : err.message },
      ]);
    });
    return { config: parseConfig(source, file), path: file };
  }

  for (const name of CONFIG_FILE_NAMES) {
    const file = resolve(cwd, name);
    const source = await readFile(file, 'utf8').catch(() => null);
    if (source !== null) return { config: parseConfig(source, file), path: file };
  }

  return { config: wardenConfigSchema.parse({}), path: null };
}

/**
 * Parse and validate config source. YAML and JSON are both accepted (JSON is parsed as YAML 1.2,
 * which keeps line numbers for errors). `file` is used only in error messages.
 */
export function parseConfig(source: string, file: string): WardenConfig {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: false });

  if (doc.errors.length > 0) {
    throw new ConfigError(
      file,
      doc.errors.map((e) => ({
        path: '',
        message: e.message.split('\n')[0] ?? e.message,
        ...position(lineCounter, e.pos[0]),
      })),
    );
  }

  const result = wardenConfigSchema.safeParse(doc.toJS() ?? {});
  if (result.success) return result.data;

  throw new ConfigError(
    file,
    result.error.issues.map((issue) => toConfigIssue(issue, doc, lineCounter)),
  );
}

function toConfigIssue(issue: z.core.$ZodIssue, doc: Document, lineCounter: LineCounter) {
  let path = issue.path.map(String);
  let node = locate(doc, path);

  // Point unknown keys at the key itself, which is where the typo is.
  if (issue.code === 'unrecognized_keys' && issue.keys[0] !== undefined) {
    const key = issue.keys[0];
    path = [...path, key];
    const parent = doc.getIn(issue.path, true);
    if (isMap(parent)) {
      const pair = parent.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
      if (isScalar(pair?.key)) node = pair.key;
    }
  }

  // Record key failures wrap the real reason (e.g. our table key regex message).
  const message =
    issue.code === 'invalid_key' ? (issue.issues[0]?.message ?? issue.message) : issue.message;

  return {
    path: path.join('.'),
    message,
    ...(node?.range ? position(lineCounter, node.range[0]) : {}),
  };
}

/** Nearest existing node for a path (missing required keys point at their parent). */
function locate(doc: Document, path: string[]): Node | undefined {
  for (let i = path.length; i >= 0; i--) {
    const node = i === 0 ? doc.contents : doc.getIn(path.slice(0, i), true);
    if (node && typeof node === 'object' && 'range' in node) return node as Node;
  }
  return undefined;
}

function position(lineCounter: LineCounter, offset: number) {
  const { line, col } = lineCounter.linePos(offset);
  return { line, column: col };
}
