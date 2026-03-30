export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "t3code:theme";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const LIGHT_THEME_COLOR = "#ffffff";
export const DARK_THEME_COLOR = "#0b0b0c";

export function coerceStoredTheme(raw: string | null): Theme {
  if (raw === "light" || raw === "dark" || raw === "system") {
    return raw;
  }

  return "system";
}

export function resolveDarkTheme(theme: Theme, systemDark: boolean): boolean {
  return theme === "dark" || (theme === "system" && systemDark);
}

export function resolveThemeColor(isDark: boolean): string {
  return isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}

export function resolveAppleStatusBarStyle(isDark: boolean): "default" | "black-translucent" {
  return isDark ? "black-translucent" : "default";
}
