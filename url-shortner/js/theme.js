/**
 * Theme Engine: Light & Dark Mode Coordinator
 * Handles persistent state (localStorage), system preference listener,
 * DOM attribute toggling, and event broadcasting.
 */

export class ThemeManager {
  constructor() {
    this.THEME_KEY = 'sysdesign_theme_preference';
    this.theme = this.getInitialTheme();
    this.init();
  }

  getInitialTheme() {
    const saved = localStorage.getItem(this.THEME_KEY);
    if (saved === 'light' || saved === 'dark') {
      return saved;
    }
    // Default to dark mode for system design visual aesthetics, or follow system
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  init() {
    this.applyTheme(this.theme, false);

    // Listen for OS system theme changes if user hasn't explicitly set preference
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem(this.THEME_KEY)) {
          this.setTheme(e.matches ? 'dark' : 'light');
        }
      });
    }

    this.attachHeaderToggle();
  }

  applyTheme(theme, save = true) {
    this.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.remove('theme-light', 'theme-dark');
    document.documentElement.classList.add(`theme-${theme}`);

    if (save) {
      localStorage.setItem(this.THEME_KEY, theme);
    }

    this.updateToggleButtons();

    // Broadcast theme change for Canvas chart and other components
    window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme } }));
  }

  toggle() {
    const nextTheme = this.theme === 'dark' ? 'light' : 'dark';
    this.applyTheme(nextTheme, true);
    return nextTheme;
  }

  setTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      this.applyTheme(theme, true);
    }
  }

  attachHeaderToggle() {
    const toggleBtn = document.getElementById('btn-theme-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.toggle();
      });
    }
  }

  updateToggleButtons() {
    const toggleBtn = document.getElementById('btn-theme-toggle');
    if (!toggleBtn) return;

    const isDark = this.theme === 'dark';
    toggleBtn.setAttribute('aria-label', isDark ? 'Switch to Light Theme' : 'Switch to Dark Theme');
    toggleBtn.setAttribute('title', isDark ? 'Switch to Light Theme' : 'Switch to Dark Theme');

    const iconEl = toggleBtn.querySelector('.theme-toggle-icon');
    const textEl = toggleBtn.querySelector('.theme-toggle-text');

    if (iconEl) {
      iconEl.innerHTML = isDark
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
    }

    if (textEl) {
      textEl.textContent = isDark ? 'Light' : 'Dark';
    }
  }
}
