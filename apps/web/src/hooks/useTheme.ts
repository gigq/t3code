import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  coerceStoredTheme,
  resolveAppleStatusBarStyle,
  resolveDarkTheme,
  resolveThemeColor,
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  type Theme,
} from "../lib/themeShell";
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
};

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: Theme | null = null;
function emitChange() {
  for (const listener of listeners) listener();
}

function getSystemDark(): boolean {
  return window.matchMedia(THEME_MEDIA_QUERY).matches;
}

function getStored(): Theme {
  return coerceStoredTheme(localStorage.getItem(THEME_STORAGE_KEY));
}

function syncThemeShell(isDark: boolean) {
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolveThemeColor(isDark));
  document
    .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute("content", resolveAppleStatusBarStyle(isDark));
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const isDark = resolveDarkTheme(theme, getSystemDark());
  document.documentElement.classList.toggle("dark", isDark);
  syncThemeShell(isDark);
  syncDesktopTheme(theme);
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

function syncDesktopTheme(theme: Theme) {
  const bridge = window.desktopBridge;
  if (!bridge || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

// Apply immediately on module load to prevent flash
applyTheme(getStored());

function getSnapshot(): ThemeSnapshot {
  const theme = getStored();
  const systemDark = theme === "system" ? getSystemDark() : false;

  if (lastSnapshot && lastSnapshot.theme === theme && lastSnapshot.systemDark === systemDark) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark };
  return lastSnapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  // Listen for system preference changes
  const mq = window.matchMedia(THEME_MEDIA_QUERY);
  const handleChange = () => {
    if (getStored() === "system") applyTheme("system", true);
    emitChange();
  };
  mq.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY) {
      applyTheme(getStored(), true);
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const theme = snapshot.theme;

  const resolvedTheme: "light" | "dark" =
    theme === "system" ? (snapshot.systemDark ? "dark" : "light") : theme;

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setTheme, resolvedTheme } as const;
}
