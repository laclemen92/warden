import type { Entity } from '@wardenhq/core';
import { Bookmark, GitCompare, History, Shield, Table2, UserCog } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, useLocation, useMatch } from 'react-router';
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
import { AUDIT_LOG_PATH, useCanViewAuditLog } from '@/lib/audit';
import { entityPath, useSchema } from '@/lib/schema';
import { ROLES_PATH, useCanManageRoles } from '@/lib/roles';
import { FROM_PARAM, useSidebarViews, viewPath, type SavedView } from '@/lib/saved-views';
import { SCHEMA_DRIFT_PATH, useCanViewSchemaDrift } from '@/lib/schema-drift';

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

function ViewNavItem({ view }: { view: SavedView }) {
  const location = useLocation();
  const isActive =
    location.pathname === entityPath({ key: view.entity }) &&
    new URLSearchParams(location.search).get(FROM_PARAM) === view.id;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={isActive} tooltip={view.name} asChild>
        <Link to={viewPath(view)}>
          <Bookmark />
          <span>{view.name}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Config views with `sidebar: true`, each opening its table with the view applied. */
function QueuesGroup() {
  const { data: views } = useSidebarViews();
  if (!views?.length) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Queues</SidebarGroupLabel>
      <SidebarGroupContent>
        <nav aria-label="Queues">
          <SidebarMenu>
            {views.map((view) => (
              <ViewNavItem key={view.id} view={view} />
            ))}
          </SidebarMenu>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar() {
  const { data: schema, isPending, isError } = useSchema();
  const [query, setQuery] = useState('');
  const canViewSchemaDrift = useCanViewSchemaDrift();
  const schemaDriftActive = useMatch(SCHEMA_DRIFT_PATH) !== null;
  const canViewAuditLog = useCanViewAuditLog();
  const auditLogActive = useMatch(AUDIT_LOG_PATH) !== null;
  const canManageRoles = useCanManageRoles();
  const rolesActive = useMatch(ROLES_PATH) !== null;

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
        <QueuesGroup />
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
        {(canViewSchemaDrift || canViewAuditLog || canManageRoles) && (
          <SidebarGroup>
            <SidebarGroupLabel>Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <nav aria-label="Admin">
                <SidebarMenu>
                  {canViewAuditLog && (
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive={auditLogActive} tooltip="Audit log" asChild>
                        <NavLink to={AUDIT_LOG_PATH}>
                          <History />
                          <span>Audit log</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                  {canManageRoles && (
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive={rolesActive} tooltip="Roles" asChild>
                        <NavLink to={ROLES_PATH}>
                          <UserCog />
                          <span>Roles</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                  {canViewSchemaDrift && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={schemaDriftActive}
                        tooltip="Schema drift"
                        asChild
                      >
                        <NavLink to={SCHEMA_DRIFT_PATH}>
                          <GitCompare />
                          <span>Schema drift</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
