import { fieldCategory, type Condition, type Entity, type Field } from '@wardenhq/core';
import { ListFilter, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  conditionToDraft,
  draftToCondition,
  fromInputValue,
  newDraft,
  operatorLabel,
  operatorsFor,
  temporalInputType,
  toInputValue,
  valueArity,
  withOperator,
  type DraftCondition,
} from '@/lib/filters';

interface ValueInputProps {
  field: Field;
  draft: DraftCondition;
  onChange: (values: string[]) => void;
}

function ValueInput({ field, draft, onChange }: ValueInputProps) {
  const arity = valueArity(draft.op);
  const category = fieldCategory(field);
  const label = `${field.label} value`;
  if (arity === 'none') return null;

  if (category === 'enum' || category === 'boolean') {
    const options = category === 'enum' ? (field.enumValues ?? []) : ['true', 'false'];
    if (arity === 'list') {
      return (
        <fieldset
          aria-label={label}
          className="flex max-h-40 min-w-40 flex-col gap-1.5 overflow-y-auto rounded-md border p-2"
        >
          {options.map((option) => {
            const checked = draft.values.includes(option);
            return (
              <label key={option} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) =>
                    onChange(
                      next ? [...draft.values, option] : draft.values.filter((v) => v !== option),
                    )
                  }
                />
                {option}
              </label>
            );
          })}
        </fieldset>
      );
    }
    return (
      <Select value={draft.values[0] ?? ''} onValueChange={(v) => onChange([v])}>
        <SelectTrigger size="sm" className="min-w-40" aria-label={label}>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (category === 'temporal') {
    const type = temporalInputType(field);
    const input = (index: number, aria: string) => (
      <Input
        type={type}
        aria-label={aria}
        className="h-8 w-auto"
        value={toInputValue(field, draft.values[index] ?? '')}
        onChange={(e) => {
          const values = [...draft.values];
          values[index] = fromInputValue(field, e.target.value);
          onChange(Array.from(values, (v) => v ?? ''));
        }}
      />
    );
    if (arity === 'range') {
      return (
        <div className="flex items-center gap-2">
          {input(0, `${field.label} from`)}
          <span className="text-sm text-muted-foreground">and</span>
          {input(1, `${field.label} to`)}
        </div>
      );
    }
    return input(0, label);
  }

  if (arity === 'range') {
    return (
      <div className="flex items-center gap-2">
        <Input
          aria-label={`${field.label} from`}
          className="h-8 w-28"
          inputMode={category === 'number' ? 'decimal' : undefined}
          value={draft.values[0] ?? ''}
          onChange={(e) => onChange([e.target.value, draft.values[1] ?? ''])}
        />
        <span className="text-sm text-muted-foreground">and</span>
        <Input
          aria-label={`${field.label} to`}
          className="h-8 w-28"
          inputMode={category === 'number' ? 'decimal' : undefined}
          value={draft.values[1] ?? ''}
          onChange={(e) => onChange([draft.values[0] ?? '', e.target.value])}
        />
      </div>
    );
  }

  if (arity === 'list') {
    return (
      <Input
        aria-label={label}
        className="h-8 w-56"
        placeholder="Comma-separated values"
        value={draft.values.join(',')}
        onChange={(e) => onChange(e.target.value.split(','))}
      />
    );
  }

  return (
    <Input
      aria-label={label}
      className="h-8 w-56"
      inputMode={category === 'number' ? 'decimal' : undefined}
      value={draft.values[0] ?? ''}
      onChange={(e) => onChange([e.target.value])}
    />
  );
}

interface ConditionRowProps {
  entity: Entity;
  draft: DraftCondition;
  error: string | undefined;
  onChange: (draft: DraftCondition) => void;
  onRemove: () => void;
}

function ConditionRow({ entity, draft, error, onChange, onRemove }: ConditionRowProps) {
  const field = entity.fields.find((f) => f.name === draft.field);
  if (!field) return null;
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-start gap-2">
        <Select
          value={draft.field}
          onValueChange={(name) => {
            const next = entity.fields.find((f) => f.name === name);
            if (next) onChange({ ...newDraft(next), id: draft.id });
          }}
        >
          <SelectTrigger size="sm" className="min-w-36" aria-label="Field">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {entity.fields.map((f) => (
              <SelectItem key={f.name} value={f.name}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={draft.op}
          onValueChange={(op) => onChange(withOperator(draft, op as DraftCondition['op']))}
        >
          <SelectTrigger size="sm" className="min-w-32" aria-label="Operator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {operatorsFor(field).map((op) => (
              <SelectItem key={op} value={op}>
                {operatorLabel(field, op)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ValueInput
          field={field}
          draft={draft}
          onChange={(values) => onChange({ ...draft, values })}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${field.label} condition`}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

interface FilterBuilderProps {
  entity: Entity;
  /** Current conditions, or `undefined` when the URL holds a filter the builder can't edit. */
  conditions: Condition[] | undefined;
  onApply: (conditions: Condition[]) => void;
}

/** Popover for editing the grid's filter as a list of conditions that must all match. */
export function FilterBuilder({ entity, conditions, onApply }: FilterBuilderProps) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<DraftCondition[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const results = drafts.map((d) => draftToCondition(entity, d));
  const errors = results.map((r) => (r.status === 'invalid' ? r.message : undefined));
  const active = conditions?.length ?? 0;

  const onOpenChange = (next: boolean) => {
    if (next) {
      const initial = (conditions ?? []).map(conditionToDraft);
      const first = entity.fields[0];
      setDrafts(initial.length > 0 || !first ? initial : [newDraft(first)]);
      setSubmitted(false);
    }
    setOpen(next);
  };

  const apply = () => {
    setSubmitted(true);
    if (errors.some(Boolean)) return;
    onApply(results.flatMap((r) => (r.status === 'ok' ? [r.condition] : [])));
    setOpen(false);
  };

  const update = (id: string, next: DraftCondition) =>
    setDrafts((list) => list.map((d) => (d.id === id ? next : d)));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <ListFilter />
          Filter
          {active > 0 && (
            <Badge variant="secondary" className="px-1.5">
              {active}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[min(90vw,48rem)] space-y-3">
        <form
          aria-label="Filters"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          {conditions === undefined && (
            <p className="text-sm text-muted-foreground">
              The current filter can't be edited here; applying replaces it.
            </p>
          )}
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conditions. All rows are shown.</p>
          ) : (
            <ul className="space-y-2">
              {drafts.map((draft, i) => (
                <ConditionRow
                  key={draft.id}
                  entity={entity}
                  draft={draft}
                  error={submitted ? errors[i] : undefined}
                  onChange={(next) => update(draft.id, next)}
                  onRemove={() => setDrafts((list) => list.filter((d) => d.id !== draft.id))}
                />
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={entity.fields.length === 0}
              onClick={() => {
                const first = entity.fields[0];
                if (first) setDrafts((list) => [...list, newDraft(first)]);
              }}
            >
              <Plus />
              Add condition
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setDrafts([])}>
                Clear
              </Button>
              <Button type="submit" size="sm">
                Apply
              </Button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
