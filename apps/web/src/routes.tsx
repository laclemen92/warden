import type { RouteObject } from 'react-router';
import { AppLayout } from '@/components/app-layout';
import { EntityPage } from '@/pages/entity-page';
import { HomePage } from '@/pages/home-page';
import { LoginPage } from '@/pages/login-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { RecordPage } from '@/pages/record-page';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'entities/:entity', element: <EntityPage /> },
      { path: 'entities/:entity/:id', element: <RecordPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
