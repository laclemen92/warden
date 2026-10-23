import { Suspense, useMemo } from 'react';
import { Outlet } from 'react-router';
import { AppSidebar } from '@/components/app-sidebar';
import { Kbd, ShortcutsProvider } from '@/components/shortcuts';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ariaKeys, detectPlatform, keyLabels, shortcut } from '@/lib/shortcuts';

function SidebarToggle() {
  const platform = useMemo(() => detectPlatform(), []);
  const chord = shortcut('sidebar').keys[0]!;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarTrigger className="-ml-1" aria-keyshortcuts={ariaKeys(chord, platform)} />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        Toggle sidebar
        <span className="flex gap-0.5">
          {keyLabels(chord, platform).map((label) => (
            <Kbd key={label} className="border-background/30 bg-background/15 text-background">
              {label}
            </Kbd>
          ))}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export function AppLayout() {
  return (
    <ShortcutsProvider>
      <SidebarProvider>
        <AppSidebar />
        {/* min-w-0: as a flex item it would otherwise grow to a wide grid's width and push the
            page past the viewport, instead of letting the grid scroll inside its container. */}
        <SidebarInset className="min-w-0">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarToggle />
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
    </ShortcutsProvider>
  );
}
