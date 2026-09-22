import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET({ fetch }) {
  try {
    const response = await fetch(`${env.LAYA_BACKEND_URL || 'http://127.0.0.1:5177'}/health`, {
      headers: env.LAYA_API_KEY ? { Authorization: `Bearer ${env.LAYA_API_KEY}` } : {}, signal: AbortSignal.timeout(3000)
    });
    if (response.status === 401 || response.status === 403) return json({ status: 'error', message: 'Set LAYA_API_KEY to match the workstation backend and restart SvelteKit.' });
    if (!response.ok) throw new Error('Health check failed');
    const result = await response.json();
    return json({ ...result, location: env.LAYA_BACKEND_URL && !/localhost|127\.0\.0\.1/.test(env.LAYA_BACKEND_URL) ? 'workstation' : 'local' });
  } catch {
    return json({ status: 'offline', message: 'Start the model service and check LAYA_BACKEND_URL in .env.' });
  }
}
