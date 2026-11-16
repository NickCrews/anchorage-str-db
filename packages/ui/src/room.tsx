import { RoomShell } from '@sqlrooms/room-shell';
import { ThemeProvider } from '@sqlrooms/ui';
import { Story } from './story/Story';
import { roomStore } from './store';

export const Room = () => (
  <ThemeProvider defaultTheme="light" storageKey="sqlrooms-ui-theme">
    <RoomShell className="h-screen" roomStore={roomStore}>
      <Story />
      <RoomShell.LoadingProgress />
    </RoomShell>
  </ThemeProvider>
);
