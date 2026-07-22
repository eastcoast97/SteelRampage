import { defineConfig } from 'vite';

export default defineConfig({
  // relative base → the build works at any mount point:
  // GitHub Pages (/SteelRampage/), Render (/), or local preview
  base: './',
});
