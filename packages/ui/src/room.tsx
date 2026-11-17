import { RoomShell } from '@sqlrooms/room-shell';
import { ThemeProvider } from '@sqlrooms/ui';
import type { FC, ReactNode } from 'react';
import { roomStore } from './store';

/** The database, theme and loading bar around one page. */
export const Room: FC<{ children: ReactNode }> = ({ children }) => (
  <ThemeProvider defaultTheme="light" storageKey="sqlrooms-ui-theme">
    <RoomShell className="h-screen" roomStore={roomStore}>
      {children}
      <RoomShell.LoadingProgress />
    </RoomShell>
  </ThemeProvider>
);
