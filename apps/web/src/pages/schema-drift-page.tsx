import type { ColumnTreatment, SchemaDrift } from '@wardenhq/core';
import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  hasSchemaChanges,
  useAcknowledgeDrift,
  useSchemaDrift,
  type SchemaDriftReport,
} from '@/lib/schema-drift';
import { NotFoundPage } from '@/pages/not-found-page';

const TREATMENT_LABELS: Record<ColumnTreatment, string> = {
  visible: 'Visible',
  readOnly: 'Read-only',
  hidden: 'Hidden',
};

export function SchemaDriftPage() {
  const { data: report, isPending, error } = useSchemaDrift();

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
  if (error) return <p className="text-muted-foreground">Couldn't load schema drift.</p>;

  return <DriftReport report={report} />;
}

function DriftReport({ report: { baseline, drift } }: { report: SchemaDriftReport }) {
  const changed = hasSchemaChanges(drift);
  const removed = [
    ...drift.removedTables.map((t) => ({ key: t.table, label: t.table, kind: 'Table' })),
    ...drift.removedColumns.map((c) => ({
      key: `${c.table}.${c.column}`,
      label: `${c.table} → ${c.column}`,
      kind: 'Column',
    })),
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Schema drift</h1>
          <p className="text-sm text-muted-foreground">
            Changes to the database since the baseline from {baseline.takenAt}
            {baseline.takenBy
              ? `, acknowledged by ${baseline.takenBy}`
              : ', recorded at first start'}
            . Reflects the schema as of Warden's last start.
          </p>
        </div>
        <AcknowledgeButton baselineId={baseline.id} disabled={!changed} />
      </div>

      {!changed && drift.warnings.length === 0 && (
        <p className="text-muted-foreground">
          No drift. The database matches the baseline and config.
        </p>
      )}

      {drift.addedTables.length > 0 && (
        <Section
          title="New tables"
          description="Created since the baseline and not mentioned in config."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead>Exposed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drift.addedTables.map(({ table, exposed }) => (
                <TableRow key={table}>
                  <TableCell className="font-mono">{table}</TableCell>
                  <TableCell>
                    <Badge variant={exposed ? 'default' : 'secondary'}>
                      {exposed ? 'Exposed' : 'Not exposed'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {drift.addedColumns.length > 0 && (
        <Section
          title="New columns"
          description="Added to exposed tables since the baseline and not mentioned in config, so defaults.newColumns decides how they are treated."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead>Column</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Treated as</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drift.addedColumns.map(({ table, column, type, treatment }) => (
                <TableRow key={`${table}.${column}`}>
                  <TableCell className="font-mono">{table}</TableCell>
                  <TableCell className="font-mono">{column}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">{type}</TableCell>
                  <TableCell>
                    <Badge variant={treatment === 'hidden' ? 'secondary' : 'default'}>
                      {TREATMENT_LABELS[treatment]}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {removed.length > 0 && (
        <Section title="Removed" description="Dropped from the database since the baseline.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {removed.map(({ key, label, kind }) => (
                <TableRow key={`${kind}:${key}`}>
                  <TableCell className="font-mono">{label}</TableCell>
                  <TableCell>{kind}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {drift.warnings.length > 0 && (
        <Section
          title="Config mismatches"
          description="Config entries that name tables or columns that don't exist or aren't exposed. Fix or remove them in your config file."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Config key</TableHead>
                <TableHead>Problem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drift.warnings.map(({ path, message }) => (
                <TableRow key={`${path}:${message}`}>
                  <TableCell className="font-mono">{path}</TableCell>
                  <TableCell>{message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {drift.snippet && <SnippetSection snippet={drift.snippet} />}
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

function SnippetSection({ snippet }: { snippet: SchemaDrift['snippet'] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the snippet is still selectable.
    }
  };

  return (
    <Section
      title="Resolve in config"
      description="Merge this into the tables section of your config. It records how the new tables and columns are treated now, so it changes nothing until you edit it."
    >
      <div className="relative">
        <pre className="overflow-x-auto rounded-lg border bg-muted p-4 font-mono text-sm">
          {snippet}
        </pre>
        <Button
          variant="outline"
          size="sm"
          className="absolute top-2 right-2"
          onClick={() => void copy()}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </Section>
  );
}

function AcknowledgeButton({ baselineId, disabled }: { baselineId: string; disabled: boolean }) {
  const acknowledge = useAcknowledgeDrift();
  const error = acknowledge.error;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={disabled || acknowledge.isPending}
        onClick={() => acknowledge.mutate(baselineId)}
      >
        Acknowledge
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof ApiError && error.status === 409
            ? 'Someone acknowledged first. Review the updated page.'
            : "Couldn't acknowledge."}
        </p>
      )}
    </div>
  );
}
