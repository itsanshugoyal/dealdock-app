/** UI preference key (never data): "light" | "dark" | "system" (DESIGN.md §2.1). */
export const THEME_STORAGE_KEY = "dealdock.theme";

/**
 * Runs in <head> before first paint: resolves the stored preference (or the
 * system setting) and stamps data-theme on <html>, so there is no flash of the
 * wrong theme. Kept server-safe (no React) because the root layout inlines it.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)");var pref=function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");return p==="light"||p==="dark"?p:"system"}catch(e){return "system"}};var apply=function(){var p=pref();d.setAttribute("data-theme",p==="system"?(m.matches?"dark":"light"):p)};apply();m.addEventListener("change",function(){if(pref()==="system")apply()})}catch(e){}})();`;
