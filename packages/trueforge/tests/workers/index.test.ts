import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../../src/workers/index';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHELL_HTML = '<div id="root"></div>';
const HTML_ACCEPT = 'text/html,application/xhtml+xml';

/** An assets binding that answers every request with the shell, carrying a header the Worker must replace. */
function recordingAssets() {
  const requests: Request[] = [];
  const assets: Fetcher = {
    async fetch(input, init) {
      requests.push(new Request(input, init));
      return new Response(SHELL_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': IMMUTABLE },
      });
    },
    connect() {
      throw new Error('connect is not used by the Worker entry');
    },
  };
  return { assets, requests };
}

async function fetchMiss({ path, init }: { path: string; init?: RequestInit<IncomingRequestCfProperties> }) {
  const { assets, requests } = recordingAssets();
  const response = await worker.fetch(
    new Request<unknown, IncomingRequestCfProperties>(`https://trueforge.test${path}`, init),
    { ...env, ASSETS: assets },
    createExecutionContext(),
  );
  return { response, requests };
}

describe('Worker entry for static asset misses', () => {
  it('returns 404 for a missing hashed asset, even when HTML is accepted', async () => {
    const { response, requests } = await fetchMiss({
      path: '/assets/gone-00000000.js',
      init: { headers: { accept: HTML_ACCEPT } },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBeNull();
    expect(requests).toEqual([]);
  });

  it('answers a navigation to a client route with the shell from / and revalidates it', async () => {
    const { response, requests } = await fetchMiss({
      path: '/sessions/some-id',
      init: { headers: { accept: HTML_ACCEPT } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    await expect(response.text()).resolves.toBe(SHELL_HTML);
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([['GET', '/']]);
  });

  it('keeps HEAD as HEAD when fetching the shell', async () => {
    const { response, requests } = await fetchMiss({
      path: '/settings',
      init: { method: 'HEAD', headers: { accept: HTML_ACCEPT } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(requests.map(request => request.method)).toEqual(['HEAD']);
  });

  it('returns 404 for requests that do not accept HTML or are not GET or HEAD', async () => {
    for (const init of [{}, { method: 'POST', headers: { accept: HTML_ACCEPT } }]) {
      const { response, requests } = await fetchMiss({ path: '/sessions/some-id', init });
      expect(response.status).toBe(404);
      expect(requests).toEqual([]);
    }
  });
});
