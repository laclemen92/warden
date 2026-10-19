import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type DataRouter } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { loginPath } from '@/lib/auth';
import { createQueryClient } from '@/lib/query-client';

/** Wires a router to a query client that sends the user to /login when any API call returns 401. */
export function createApp(createRouter: () => DataRouter): {
  router: DataRouter;
  queryClient: QueryClient;
} {
  const router = createRouter();
  const queryClient = createQueryClient(() => {
    const { pathname, search } = router.state.location;
    if (pathname === '/login') return;
    void router.navigate(loginPath(pathname + search), { replace: true });
  });
  return { router, queryClient };
}

export function App({ router, queryClient }: { router: DataRouter; queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
