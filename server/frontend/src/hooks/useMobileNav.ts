import { useEffect, useRef } from 'react';
import { useAppState, useAppDispatch } from '../context/AppContext';
import { useIsMobile } from './useIsMobile';

/**
 * Manages mobile view-switching navigation via browser history.
 *
 * - When a session is selected (activeKey set) on mobile → pushes a history entry
 * - When browser back is triggered (popstate) → clears activeKey to show session list
 * - Desktop is unaffected
 */
export function useMobileNav() {
  const isMobile = useIsMobile();
  const { activeKey } = useAppState();
  const dispatch = useAppDispatch();

  // Track whether we pushed a history entry for the current chat view
  const pushedRef = useRef(false);
  // Track the previous activeKey to detect changes
  const prevKeyRef = useRef<string | null>(null);

  // When activeKey changes on mobile, push history state
  useEffect(() => {
    if (!isMobile) {
      pushedRef.current = false;
      return;
    }

    if (activeKey && activeKey !== prevKeyRef.current) {
      // User selected a new session → push history entry
      history.pushState({ view: 'chat', chatKey: activeKey }, '');
      pushedRef.current = true;
    }

    prevKeyRef.current = activeKey;
  }, [activeKey, isMobile]);

  // Listen for popstate (browser back gesture / back button)
  useEffect(() => {
    if (!isMobile) return;

    const handlePopState = () => {
      // Going back → return to session list
      if (pushedRef.current) {
        pushedRef.current = false;
        prevKeyRef.current = null;
        dispatch({ type: 'SET_ACTIVE_KEY', key: null });
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isMobile, dispatch]);
}
