// Page shell, shared by the deals report and the order history: the current nav item,
// menus (a [aria-haspopup=menu] trigger opens the .menu its aria-controls names; Esc and
// an outside click close it) and the System / Light / Dark theme switch.
const d = document;
const THEME_KEY = "deal_radar_theme";

function stored(fn) {
  try { return fn(); } catch { return null; }   // private mode or blocked site data: no value
}

for (const a of d.querySelectorAll('#topnav a[href^="/"]')) {
  if (a.getAttribute("href") === location.pathname) a.setAttribute("aria-current", "page");
}

const triggers = (m) => d.querySelectorAll(`[aria-controls="${m.id}"][aria-haspopup="menu"]`);
function closeMenu(m) {
  if (m.hidden) return;
  m.hidden = true;
  triggers(m).forEach((t) => t.setAttribute("aria-expanded", "false"));
}
// Under the trigger, flipped left or above when it would leave the viewport.
function place(m, t) {
  const r = t.getBoundingClientRect();
  let x = r.left, y = r.bottom + 6;
  if (x + m.offsetWidth > innerWidth - 8) x = Math.max(8, r.right - m.offsetWidth);
  if (y + m.offsetHeight > innerHeight - 8 && r.top - m.offsetHeight - 6 > 8) y = r.top - m.offsetHeight - 6;
  m.style.left = x + "px";
  m.style.top = y + "px";
}
d.addEventListener("click", (e) => {
  const t = e.target.closest('[aria-haspopup="menu"][aria-controls]');
  const open = d.querySelectorAll(".menu:not([hidden])");
  if (!t) { open.forEach((m) => { if (!m.contains(e.target)) closeMenu(m); }); return; }
  const m = d.getElementById(t.getAttribute("aria-controls"));
  if (!m) return;
  e.preventDefault();
  const was = !m.hidden;
  open.forEach(closeMenu);
  if (was) return;
  m.hidden = false;
  t.setAttribute("aria-expanded", "true");
  place(m, t);
});
d.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  d.querySelectorAll(".menu:not([hidden])").forEach((m) => { closeMenu(m); triggers(m)[0]?.focus(); });
});
addEventListener("resize", () => d.querySelectorAll(".menu:not([hidden])").forEach(closeMenu));

function markTheme() {
  const cur = d.documentElement.getAttribute("data-theme") || "system";
  d.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === cur)));
  d.dispatchEvent(new CustomEvent("themechange"));
}
d.addEventListener("click", (e) => {
  const b = e.target.closest("[data-theme-set]");
  if (!b) return;
  const v = b.dataset.themeSet;
  stored(() => (v === "system" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, v)));
  if (v === "system") d.documentElement.removeAttribute("data-theme");
  else d.documentElement.setAttribute("data-theme", v);
  markTheme();
});
markTheme();
