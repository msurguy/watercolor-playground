import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { AppStore } from './store';

export const AppContext = createContext<AppStore | null>(null);

/** The app store; components are always rendered inside <AppContext.Provider>. */
export function useApp(): AppStore {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp outside <AppContext.Provider>');
  return app;
}
