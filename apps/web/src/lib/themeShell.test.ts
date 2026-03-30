import { describe, expect, it } from "vitest";

import {
  coerceStoredTheme,
  DARK_THEME_COLOR,
  LIGHT_THEME_COLOR,
  resolveAppleStatusBarStyle,
  resolveDarkTheme,
  resolveThemeColor,
} from "./themeShell";

describe("themeShell", () => {
  it("coerces unsupported theme values to system", () => {
    expect(coerceStoredTheme("light")).toBe("light");
    expect(coerceStoredTheme("dark")).toBe("dark");
    expect(coerceStoredTheme("system")).toBe("system");
    expect(coerceStoredTheme("sepia")).toBe("system");
    expect(coerceStoredTheme(null)).toBe("system");
  });

  it("resolves the effective dark mode state", () => {
    expect(resolveDarkTheme("dark", false)).toBe(true);
    expect(resolveDarkTheme("light", true)).toBe(false);
    expect(resolveDarkTheme("system", true)).toBe(true);
    expect(resolveDarkTheme("system", false)).toBe(false);
  });

  it("returns the correct shell colors and status bar style", () => {
    expect(resolveThemeColor(false)).toBe(LIGHT_THEME_COLOR);
    expect(resolveThemeColor(true)).toBe(DARK_THEME_COLOR);
    expect(resolveAppleStatusBarStyle(false)).toBe("default");
    expect(resolveAppleStatusBarStyle(true)).toBe("black-translucent");
  });
});
