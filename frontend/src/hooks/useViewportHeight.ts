import { useEffect } from 'react';

/**
 * Tracks the visual viewport and sets CSS custom properties on <html>:
 *
 *   --app-h   : visualViewport.height   (shrinks when iOS keyboard opens)
 *   --app-top : visualViewport.offsetTop (iOS may scroll the visual viewport)
 *   --kb-open : "1" when keyboard appears to be open, "0" otherwise
 *
 * Android with `interactive-widget=resizes-content` already resizes the
 * layout viewport, so these values are essentially no-ops there.
 *
 * iOS Safari doesn't support `interactive-widget` — the layout viewport
 * stays at full-screen height and the keyboard overlays the bottom.
 * By setting #root to `position:fixed; height:var(--app-h); top:var(--app-top)`
 * we pin the app to the visible area above the keyboard.
 */
export function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;

    const update = () => {
      const h = vv.height;
      const top = vv.offsetTop;

      root.style.setProperty('--app-h', `${h}px`);
      root.style.setProperty('--app-top', `${top}px`);

      // Keyboard is likely open when the visible area is notably smaller
      // than the layout viewport (threshold: 150px to ignore URL-bar changes)
      const kbOpen = window.innerHeight - h > 150;
      root.toggleAttribute('data-kb-open', kbOpen);
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--app-h');
      root.style.removeProperty('--app-top');
      root.removeAttribute('data-kb-open');
    };
  }, []);
}
