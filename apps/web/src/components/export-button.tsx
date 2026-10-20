import { useMutation } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadExport } from '@/lib/export';

/** Downloads the grid as CSV. Only shown to users who may export; the server checks again. */
export function ExportButton({ url, fallbackName }: { url: string; fallbackName: string }) {
  const download = useMutation({
    mutationFn: () => downloadExport(url, fallbackName),
  });
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={download.isPending}
        onClick={() => download.mutate()}
      >
        <Download />
        {download.isPending ? 'Exporting…' : 'Export CSV'}
      </Button>
      {download.isError && (
        <p role="alert" className="text-sm text-destructive">
          {download.error.message}
        </p>
      )}
    </div>
  );
}
