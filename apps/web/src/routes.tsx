import { lazy, type ComponentType } from 'react';
import type { RouteObject } from 'react-router';

// Every page is its own chunk, so /login never downloads the shell, sidebar or grid. Pages under
// the layout use React.lazy so their loading state renders inside the layout's <Suspense>; the
// layout and /login use route `lazy`, covered by the root's fallback on first load.
function page(load: () => Promise<ComponentType>) {
  const Page = lazy(async () => ({ default: await load() }));
  return <Page />;
}

export const routes: RouteObject[] = [
  {
    hydrateFallbackElement: <div className="min-h-svh" aria-busy="true" />,
    children: [
      {
        path: '/login',
        lazy: async () => ({ Component: (await import('@/pages/login-page')).LoginPage }),
      },
      {
        lazy: async () => ({ Component: (await import('@/components/app-layout')).AppLayout }),
        children: [
          { index: true, element: page(async () => (await import('@/pages/home-page')).HomePage) },
          {
            path: 'entities/:entity',
            element: page(async () => (await import('@/pages/entity-page')).EntityPage),
          },
          {
            path: 'entities/:entity/-/new',
            element: page(async () => (await import('@/pages/record-form-page')).CreateRecordPage),
          },
          {
            path: 'entities/:entity/:id/edit',
            element: page(async () => (await import('@/pages/record-form-page')).EditRecordPage),
          },
          {
            path: 'entities/:entity/:id',
            element: page(async () => (await import('@/pages/record-page')).RecordPage),
          },
          {
            path: 'admin/schema-drift',
            element: page(async () => (await import('@/pages/schema-drift-page')).SchemaDriftPage),
          },
          {
            path: 'admin/audit',
            element: page(async () => (await import('@/pages/audit-log-page')).AuditLogPage),
          },
          {
            path: 'admin/roles',
            element: page(async () => (await import('@/pages/roles-page')).RolesPage),
          },
          {
            path: 'help',
            element: page(async () => (await import('@/pages/help-page')).HelpPage),
          },
          {
            path: '*',
            element: page(async () => (await import('@/pages/not-found-page')).NotFoundPage),
          },
        ],
      },
    ],
  },
];
