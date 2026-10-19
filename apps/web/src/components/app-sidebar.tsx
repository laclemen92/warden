import type { Entity } from '@wardenhq/core';
import { Shield, Table2 } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, useMatch } from 'react-router';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';
import { UserMenu } from '@/components/user-menu';
import { entityPath, useSchema } from '@/lib/schema';

function EntityNavItem({ entity }: { entity: Entity }) {
  const path = entityPath(entity);
  const isActive = useMatch({ path, end: false }) !== null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={isActive} tooltip={entity.label} asChild>
        <NavLink to={path}>
          <Table2 />
          <span>{entity.label}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const { data: schema, isPending, isError } = useSchema();
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const entities = (schema?.entities ?? [])
    .filter((e) => !needle || e.label.toLowerCase().includes(needle) || e.key.includes(needle))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Shield className="size-4" />
                </div>
                <span className="font-semibold">Warden</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarInput
          placeholder="Filter entities…"
          aria-label="Filter entities"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Entities</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Entities">
              <SidebarMenu>
                {isPending &&
                  Array.from({ length: 5 }, (_, i) => (
                    <SidebarMenuItem key={i}>
                      <SidebarMenuSkeleton showIcon />
                    </SidebarMenuItem>
                  ))}
                {isError && (
                  <p className="px-2 text-sm text-muted-foreground">Couldn't load entities.</p>
                )}
                {schema && entities.length === 0 && (
                  <p className="px-2 text-sm text-muted-foreground">No entities.</p>
                )}
                {entities.map((entity) => (
                  <EntityNavItem key={entity.key} entity={entity} />
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
