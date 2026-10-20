import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // The Python venv (~28k files), the Hugging Face cache and eval runs live in the project root.
    // Watching them blocks the dev server's event loop while the watcher crawls, which held the
    // first page load at ~40 s instead of ~0.6 s. None of them are UI sources.
    watch: { ignored: ['**/.backend-venv/**', '**/.venv/**', '**/.cache/**', '**/_workspace/**', '**/_workspace_*/**'] }
  }
});
