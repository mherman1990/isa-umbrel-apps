// UI theme: light / dark / system (follow the OS). Persisted locally on the
// device — a display preference, not farm data, so it never touches the API or
// the backup. `system` re-evaluates live when the OS theme flips.

export type Theme = "system" | "light" | "dark";

const KEY = "farmos_theme";

export function getTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function setTheme(theme: Theme) {
  if (theme === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

// Stamp the chosen theme on <html>. For `system` we leave data-theme off so the
// CSS `prefers-color-scheme` fallback takes over. Called before first paint
// (main.tsx) to avoid a light-mode flash, and again on every change.
export function applyTheme(theme: Theme = getTheme()) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}
