import { QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError, isUnauthorized } from './api';

export function createQueryClient(onUnauthorized: () => void): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (err) => {
        if (isUnauthorized(err)) onUnauthorized();
      },
    }),
    defaultOptions: {
      queries: {
        // Client errors (401, 404, ...) won't succeed on retry.
        retry: (failureCount, err) =>
          !(err instanceof ApiError && err.status < 500) && failureCount < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}
