import { FileDropzone } from '@sqlrooms/dropzone';
import { RoomPanel } from '@sqlrooms/room-shell';
import { SchemaExplorer } from '@sqlrooms/sql-editor';
import { toast } from '@sqlrooms/ui';
import { convertToValidColumnOrTableName } from '@sqlrooms/utils';
import type { FC } from 'react';
import { useRoomStore } from '../store';

export const DataPanel: FC = () => {
  const status = useRoomStore((s) => s.dataInit.status);
  const error = useRoomStore((s) => s.dataInit.error);
  const connector = useRoomStore((state) => state.db.connector);
  const refreshTableSchemas = useRoomStore(
    (state) => state.db.refreshTableSchemas,
  );

  return (
    <RoomPanel>
      <div className="px-1 pb-3 text-xs">
        {status === 'loading' && (
          <p className="text-muted-foreground">Attaching anchorage_str.duckdb…</p>
        )}
        {status === 'error' && (
          <p className="text-destructive whitespace-pre-wrap">
            Failed to load the database: {error}
          </p>
        )}
        {status === 'ready' && (
          <p className="text-muted-foreground">
            <span className="font-medium">airbnb_listing_observations</span>,{' '}
            <span className="font-medium">airbnb_calendar_status</span>,{' '}
            <span className="font-medium">listings</span>,{' '}
            <span className="font-medium">calendar_current</span> and{' '}
            <span className="font-medium">airbnb_scrape_runs</span> are views over
            the attached, read-only <code>anchorage_str.duckdb</code> snapshot
            — see the root README for table descriptions.
          </p>
        )}
      </div>
      <FileDropzone
        className="h-32 p-4"
        acceptedFormats={{
          'text/csv': ['.csv'],
          'text/tsv': ['.tsv'],
          'application/json': ['.json'],
          'application/octet-stream': ['.parquet'],
        }}
        onDrop={async (files) => {
          for (const file of files) {
            try {
              const tableName = convertToValidColumnOrTableName(file.name);
              await connector.loadFile(file, tableName);
              toast.success('Table created', {
                description: `${file.name} loaded as ${tableName}`,
              });
            } catch (err) {
              toast.error('Error loading file', {
                description: `${file.name}: ${err}`,
              });
            }
          }
          await refreshTableSchemas();
        }}
      >
        <div className="text-muted-foreground text-xs">
          Drop a CSV/TSV/JSON/Parquet file to join against it — e.g. a
          parcel export. Stays local to your browser.
        </div>
      </FileDropzone>
      <SchemaExplorer>
        <SchemaExplorer.Header>
          <SchemaExplorer.RefreshButton />
        </SchemaExplorer.Header>
        <SchemaExplorer.Tree className="h-full" />
      </SchemaExplorer>
    </RoomPanel>
  );
};
