import type { SharedViewsMode, WardenConfig } from '@wardenhq/config';
import {
  CONFIG_VIEW_PREFIX,
  adminAreas,
  configViewId,
  isAllowed,
  namesRestrictedField,
  validateViewState,
  viewName,
  VIEW_LIMITS,
  type ConfigView,
  type Entity,
  type FilterError,
  type Policy,
  type ViewState,
} from '@wardenhq/core';
import {
  createSavedView,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  listSharedViews,
  updateSavedView,
  type Database,
  type SavedView,
  type SavedViewResult,
} from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Views } from '../views.js';
import { NO_NUL } from './schemas.js';

export interface SavedViewOptions {
  db: Database;
  policy: Policy;
  views: Views;
  /** Config `roles`, for `admin: [views]`, which may share views. */
  roles: WardenConfig['roles'];
  /** Views from `tables.<table>.views`, checked against the schema at startup. */
  configViews?: readonly ConfigView[];
  /** `defaults.sharedViews`; `both` when absent. */
  sharedViews?: SharedViewsMode;
}

/** A saved view as one user sees it. */
export interface SavedViewItem {
  /** Numeric for saved views, `config:<key>` for config views. */
  id: string;
  entity: string;
  name: string;
  /** Where it comes from: config, a view shared in the UI, or the user's own private view. */
  origin: 'config' | 'shared' | 'personal';
  shared: boolean;
  /** Whether the current user owns it. */
  mine: boolean;
  /** Who saved it, for shared views of other users. */
  owner: string | null;
  /** Whether the current user may change it. */
  canEdit: boolean;
  /** Whether the current user may delete it. */
  canDelete: boolean;
  /**
   * Null when the view names a field the current user can't see (dropped, hidden since, or
   * restricted by `readableBy`). Only users who may delete such a view are shown it at all, and
   * of those, only its owner when the field is restricted.
   */
  state: ViewState | null;
  /** Absent for config views. */
  updatedAt?: string;
  /** Config views: the key in config. */
  key?: string;
  /** Config views: shown in the sidebar. */
  sidebar?: true;
  /** Config views: applied when the table is opened without other grid state. */
  default?: true;
  /**
   * With `defaults.sharedViews: config`, a view shared in the UI, which nobody else sees any more.
   * Only its owner and views admins see it, to export it to config or delete it.
   */
  notInConfig?: true;
}

// Checked in the handler rather than by a schema, so a malformed id 404s like a missing one.
const ID = /^[1-9][0-9]{0,18}$/;
const MAX_ID = 2n ** 63n - 1n;
// Ids beyond bigint can't exist, and Postgres would fail on them rather than find nothing.
const isId = (id: string) => ID.test(id) && BigInt(id) <= MAX_ID;
const nameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: VIEW_LIMITS.maxNameLength,
  pattern: NO_NUL,
} as const;
// The state's contents are checked against the entity by `validateViewState`.
const stateSchema = { type: 'object' } as const;

interface CreateBody {
  entity: string;
  name: string;
  shared?: boolean;
  state: unknown;
}
interface UpdateBody {
  name?: string;
  shared?: boolean;
  state?: unknown;
}

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });

const forbidden = (reply: FastifyReply) =>
  reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: 'Forbidden' });

const badRequest = (reply: FastifyReply, message: string, details?: FilterError[]) =>
  reply
    .code(400)
    .send({ statusCode: 400, error: 'Bad Request', message, ...(details ? { details } : {}) });

const duplicate = (reply: FastifyReply) =>
  reply.code(409).send({
    statusCode: 409,
    error: 'Conflict',
    message: 'you already have a view with this name',
  });

/**
 * Saved grid views. Anyone who can read an entity may save views of it for themselves; sharing
 * one with everyone takes `admin: [views]`. A view only exists for users who can read its
 * entity, and its state is checked against the entity as each user sees it, so a view never
 * reveals a field to someone who can't see it.
 */
export function registerSavedViewRoutes(
  app: FastifyInstance,
  { db, policy, views, roles, configViews = [], sharedViews = 'both' }: SavedViewOptions,
) {
  const isViewsAdmin = (req: FastifyRequest) =>
    adminAreas(roles, req.roles ?? []).includes('views');
  // With `sharedViews: config`, shared views come only from config.
  const canShare = (req: FastifyRequest) => sharedViews !== 'config' && isViewsAdmin(req);
  const configOnly = sharedViews === 'config';
  const configById = new Map(configViews.map((v) => [configViewId(v.key), v]));

  /** The entity as the caller sees it, if they may read it. */
  const readable = (req: FastifyRequest, key: string): Entity | undefined =>
    isAllowed(policy, req.roles ?? [], key, 'read')
      ? views(req.roles).entities.get(key)
      : undefined;

  // Owners may always delete their views, but changing a shared view takes the permission.
  const mayDelete = (req: FastifyRequest, view: SavedView) =>
    view.ownerSubject === req.session!.subject || (view.shared && isViewsAdmin(req));
  const mayEdit = (req: FastifyRequest, view: SavedView) =>
    view.shared ? canShare(req) : view.ownerSubject === req.session!.subject;

  /** The view as the caller sees it, or undefined if, to them, it doesn't exist. */
  const present = (req: FastifyRequest, view: SavedView): SavedViewItem | undefined => {
    const mine = view.ownerSubject === req.session!.subject;
    if (!mine && !view.shared) return undefined;
    // Left over from before config mode: gone for everyone but those who can clean it up.
    if (configOnly && view.shared && !mine && !isViewsAdmin(req)) return undefined;
    const entity = readable(req, view.entity);
    if (!entity) return undefined;
    const state = validateViewState(entity, view.state);
    if (!state.ok) {
      if (!mayDelete(req, view)) return undefined;
      // Views admins could otherwise learn of a restricted field, and from the view's name what
      // it's about. Its owner wrote the name and saw the field, so they still see it.
      if (!mine && namesRestrictedField(policy, req.roles ?? [], view.entity, view.state)) {
        return undefined;
      }
    }
    return {
      id: view.id,
      entity: view.entity,
      name: view.name,
      origin: view.shared ? 'shared' : 'personal',
      shared: view.shared,
      mine,
      owner: view.ownerName,
      canEdit: mayEdit(req, view),
      canDelete: mayDelete(req, view),
      state: state.ok ? state.state : null,
      updatedAt: view.updatedAt,
      ...(configOnly && view.shared ? { notInConfig: true as const } : {}),
    };
  };

  /**
   * A config view as the caller sees it. Like a shared view, it exists only for users who can
   * read its table and every field it uses; unlike one, nobody can change or delete it.
   */
  const presentConfig = (req: FastifyRequest, view: ConfigView): SavedViewItem | undefined => {
    const entity = readable(req, view.entity);
    if (!entity || !validateViewState(entity, view.state).ok) return undefined;
    return {
      id: configViewId(view.key),
      entity: view.entity,
      name: view.name,
      origin: 'config',
      shared: true,
      mine: false,
      owner: null,
      canEdit: false,
      canDelete: false,
      state: view.state,
      key: view.key,
      ...(view.sidebar ? { sidebar: true as const } : {}),
      ...(view.default ? { default: true as const } : {}),
    };
  };

  const saved = (req: FastifyRequest, reply: FastifyReply, result: SavedViewResult) => {
    if (!result.ok) return result.reason === 'duplicate' ? duplicate(reply) : notFound(reply);
    return present(req, result.view) ?? notFound(reply);
  };

  /** Load a view the caller can see, sending a 404 otherwise. */
  const load = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (req.params.id.startsWith(CONFIG_VIEW_PREFIX)) {
      const config = configById.get(req.params.id);
      const item = config && presentConfig(req, config);
      if (!item) notFound(reply);
      return item ? { view: undefined, item } : undefined;
    }
    const view = isId(req.params.id) ? await getSavedView(db, req.params.id) : undefined;
    const item = view && present(req, view);
    if (!view || !item) {
      notFound(reply);
      return undefined;
    }
    return { view, item };
  };

  app.get<{ Querystring: { entity: string } }>(
    '/api/views',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['entity'],
          properties: { entity: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      // Unreadable entities 404 exactly like nonexistent ones, as on the entity routes.
      if (!readable(req, req.query.entity)) return notFound(reply);
      const rows = await listSavedViews(db, {
        entity: req.query.entity,
        subject: req.session!.subject,
      });
      return {
        views: [
          ...configViews.flatMap((view) =>
            view.entity === req.query.entity ? (presentConfig(req, view) ?? []) : [],
          ),
          ...rows.flatMap((view) => present(req, view) ?? []),
        ],
        // Whether the caller may share views here, so the UI can leave out the controls.
        canShare: canShare(req),
      };
    },
  );

  // Config views with their own sidebar entry, of every table.
  app.get('/api/views/sidebar', async (req) => ({
    views: configViews.flatMap((view) => (view.sidebar ? (presentConfig(req, view) ?? []) : [])),
  }));

  // Every view shared in the UI, of every table, for views admins to export to config.
  app.get('/api/views/shared', async (req, reply) => {
    if (!isViewsAdmin(req)) return forbidden(reply);
    const rows = await listSharedViews(db);
    return {
      views: rows.flatMap((view) => {
        const item = present(req, view);
        return item?.state ? [item] : [];
      }),
    };
  });

  app.get<{ Params: { id: string } }>(
    '/api/views/:id',
    async (req, reply) => (await load(req, reply))?.item ?? reply,
  );

  app.post<{ Body: CreateBody }>(
    '/api/views',
    {
      schema: {
        body: {
          type: 'object',
          required: ['entity', 'name', 'state'],
          additionalProperties: false,
          properties: {
            entity: { type: 'string', minLength: 1, maxLength: 200 },
            name: nameSchema,
            shared: { type: 'boolean' },
            state: stateSchema,
          },
        },
      },
    },
    async (req, reply) => {
      const entity = readable(req, req.body.entity);
      if (!entity) return notFound(reply);
      const shared = req.body.shared ?? false;
      if (shared && !canShare(req)) return forbidden(reply);
      const name = viewName(req.body.name);
      if (!name) return badRequest(reply, 'name must not be blank');
      const state = validateViewState(entity, req.body.state);
      if (!state.ok) return badRequest(reply, 'invalid view', state.errors);
      const session = req.session!;
      const owner = session.name ?? session.email;
      const result = await createSavedView(db, {
        entity: entity.key,
        name,
        ownerSubject: session.subject,
        ...(owner ? { ownerName: owner } : {}),
        shared,
        state: state.state,
      });
      if (result.ok) reply.code(201);
      return saved(req, reply, result);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateBody }>(
    '/api/views/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { name: nameSchema, shared: { type: 'boolean' }, state: stateSchema },
        },
      },
    },
    async (req, reply) => {
      const found = await load(req, reply);
      if (!found) return reply;
      const { view } = found;
      // Config views change only through config.
      if (!view) return forbidden(reply);
      // Sharing, unsharing, or changing a shared view all take the permission.
      if (!mayEdit(req, view)) return forbidden(reply);
      if (req.body.shared !== undefined && req.body.shared !== view.shared && !canShare(req)) {
        return forbidden(reply);
      }
      let name;
      if (req.body.name !== undefined) {
        name = viewName(req.body.name);
        if (!name) return badRequest(reply, 'name must not be blank');
      }
      let state;
      if (req.body.state !== undefined) {
        const result = validateViewState(
          views(req.roles).entities.get(view.entity)!,
          req.body.state,
        );
        if (!result.ok) return badRequest(reply, 'invalid view', result.errors);
        state = result.state;
      }
      const result = await updateSavedView(
        db,
        view.id,
        {
          ...(name !== undefined ? { name } : {}),
          ...(req.body.shared !== undefined ? { shared: req.body.shared } : {}),
          ...(state !== undefined ? { state } : {}),
        },
        { expectShared: view.shared },
      );
      return saved(req, reply, result);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/views/:id', async (req, reply) => {
    const found = await load(req, reply);
    if (!found) return reply;
    const { view } = found;
    if (!view || !mayDelete(req, view)) return forbidden(reply);
    const deleted = await deleteSavedView(db, view.id, { expectShared: view.shared });
    return deleted ? reply.code(204).send() : notFound(reply);
  });
}
