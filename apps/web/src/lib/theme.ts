export type Theme = "light" | "dark" | "system";

export function getTheme(): Theme {
  try {
    return (localStorage.getItem("cosimo-theme") as Theme) || "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme = getTheme()) {
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem("cosimo-theme", t);
  } catch {}
  applyTheme(t);
}
