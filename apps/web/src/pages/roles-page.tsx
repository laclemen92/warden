import { X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/api';
import {
  describeGrants,
  useAssignRole,
  useRoles,
  useUnassignRole,
  type RoleAssignment,
  type RolesReport,
} from '@/lib/roles';
import { NotFoundPage } from '@/pages/not-found-page';

export function RolesPage() {
  const { data: report, isPending, error } = useRoles();

  if (isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  // Users without access get the same 404 as a page that doesn't exist.
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <p className="text-muted-foreground">Couldn't load roles.</p>;

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Roles</h1>
        <p className="text-sm text-muted-foreground">
          Config defines the roles and who gets them at sign-in. Assign extra roles to people here;
          changes apply on their next request and are recorded in the audit log.
        </p>
      </div>
      <AssignmentsSection report={report} />
      <RolesSection roles={report.roles} />
      <AccessSection access={report.access} />
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function AssignmentsSection({ report }: { report: RolesReport }) {
  return (
    <Section
      title="Assignments"
      description="Roles given to people by email, on top of the ones config gives them. Someone with an assignment can sign in even if no access rule matches them. Their email must be verified by the identity provider."
    >
      <AssignForm roles={report.roles.map((r) => r.name)} />
      {report.assignments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assignments yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Assigned by</TableHead>
              <TableHead>Assigned at</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.assignments.map((assignment) => (
              <AssignmentRow key={`${assignment.email}:${assignment.role}`} {...assignment} />
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function AssignmentRow({ email, role, assignedBy, assignedAt, defined }: RoleAssignment) {
  const unassign = useUnassignRole();
  const error = unassign.error;
  return (
    <TableRow>
      <TableCell className="font-mono">{email}</TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{role}</Badge>
          {!defined && (
            <Badge
              variant="outline"
              title="Config no longer defines this role, so it has no effect."
            >
              Not in config
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{assignedBy}</TableCell>
      <TableCell className="text-muted-foreground">{assignedAt}</TableCell>
      <TableCell className="text-right">
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${role} from ${email}`}
            disabled={unassign.isPending}
            onClick={() => unassign.mutate({ email, role })}
          >
            <X />
            Remove
          </Button>
          {error && !(error instanceof ApiError && error.status === 404) && (
            <p role="alert" className="text-sm text-destructive">
              Couldn't remove.
            </p>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function AssignForm({ roles }: { roles: string[] }) {
  const assign = useAssignRole();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    assign.mutate(
      { email, role },
      {
        onSuccess: () => {
          setEmail('');
          setRole('');
        },
      },
    );
  };

  const error = assign.error;
  return (
    <form aria-label="Assign a role" className="space-y-2" onSubmit={submit}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          required
          placeholder="person@example.com"
          aria-label="Email"
          className="max-w-72"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="min-w-40" aria-label="Role">
            <SelectValue placeholder="Choose a role…" />
          </SelectTrigger>
          <SelectContent>
            {roles.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={!email.trim() || !role || assign.isPending}>
          Assign
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {/* 400 and 409 messages are written for people (invalid email, already assigned). */}
          {error instanceof ApiError && (error.status === 400 || error.status === 409)
            ? error.message
            : "Couldn't assign the role."}
        </p>
      )}
    </form>
  );
}

function RolesSection({ roles }: { roles: RolesReport['roles'] }) {
  return (
    <Section
      title="Defined roles"
      description="From the roles section of your config. Edit the config file to change them."
    >
      {roles.length === 0 ? (
        <p className="text-sm text-muted-foreground">Config defines no roles.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead>Grants</TableHead>
              <TableHead>Admin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map(({ name, grants, admin }) => {
              const lines = describeGrants(grants);
              return (
                <TableRow key={name}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell className="font-mono text-sm">
                    {lines.length === 0 ? (
                      <span className="text-muted-foreground">None</span>
                    ) : (
                      lines.map((line) => <div key={line}>{line}</div>)
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {admin.map((area) => (
                        <Badge key={area} variant="secondary">
                          {area}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function AccessSection({ access }: { access: RolesReport['access'] }) {
  const rules = access
    ? [
        ...Object.entries(access.groups).map(([group, roles]) => ({
          kind: 'Group',
          match: group,
          roles,
        })),
        ...Object.entries(access.emailDomains).map(([domain, roles]) => ({
          kind: 'Email domain',
          match: domain,
          roles,
        })),
      ]
    : [];

  return (
    <Section
      title="Access rules"
      description="From the access section of your config: roles people get at sign-in from their identity provider groups and email domain."
    >
      {!access ? (
        <p className="text-sm text-muted-foreground">
          No access rules. Everyone the identity provider authenticates can sign in, with no roles
          unless assigned some above.
        </p>
      ) : rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rules, so only people with an assignment can sign in.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Matches</TableHead>
              <TableHead>Roles</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map(({ kind, match, roles }) => (
              <TableRow key={`${kind}:${match}`}>
                <TableCell>{kind}</TableCell>
                <TableCell className="font-mono">{match}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {roles.map((role) => (
                      <Badge key={role} variant="secondary">
                        {role}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
