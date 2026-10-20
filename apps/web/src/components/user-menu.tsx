import { useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { logout, useCurrentUser, type CurrentUser } from '@/lib/auth';

function displayName(user: CurrentUser): string {
  return user.name ?? user.email ?? 'Anonymous';
}

function initials(name: string): string {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  );
}

export function UserMenu() {
  const { data: user, isPending } = useCurrentUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  if (isPending) return <Skeleton className="h-12 w-full" />;

  const name = displayName(user ?? {});
  const email = user?.email && user.email !== name ? user.email : undefined;

  const onLogout = async () => {
    const idpLogout = await logout();
    queryClient.clear();
    // The IdP sends the browser back to Warden, which then shows the login page.
    if (idpLogout) window.location.assign(idpLogout);
    else await navigate('/login', { replace: true });
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label="Account">
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">{initials(name)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{name}</span>
                {email && <span className="truncate text-xs text-muted-foreground">{email}</span>}
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width)"
          >
            <DropdownMenuLabel className="font-normal">
              <div className="truncate font-medium">{name}</div>
              {email && <div className="truncate text-xs text-muted-foreground">{email}</div>}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void onLogout()}>
              <LogOut />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
