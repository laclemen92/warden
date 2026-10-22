import { Suspense } from 'react';
import { Outlet } from 'react-router';
import { AppSidebar } from '@/components/app-sidebar';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';

export function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* min-w-0: as a flex item it would otherwise grow to a wide grid's width and push the
          page past the viewport, instead of letting the grid scroll inside its container. */}
      <SidebarInset className="min-w-0">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <span className="text-sm text-muted-foreground">Warden</span>
        </header>
        <div className="flex-1 p-6">
          <Suspense fallback={<Skeleton className="h-8 w-48" aria-label="Loading" />}>
            <Outlet />
          </Suspense>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
