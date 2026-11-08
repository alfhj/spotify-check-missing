import assert from 'node:assert/strict';
import test from 'node:test';
import { SpotifyClient, SpotifyError } from '../src/spotify.js';

function session(overrides = {}) {
  return {
    clientId: '0123456789abcdef0123456789abcdef',
    tokens: {
      access_token: 'access-old',
      refresh_token: 'refresh-old',
      expires_at: Date.now() + 60 * 60 * 1000,
      ...overrides,
    },
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('uses a valid access token without refreshing', async () => {
  const requests = [];
  const client = new SpotifyClient(session(), {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return json({ id: 'me' });
    },
  });

  assert.deepEqual(await client.get('/me'), { id: 'me' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.spotify.com/v1/me');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer access-old');
});

test('refreshes an expired access token', async () => {
  const requests = [];
  const target = session({ expires_at: 0 });
  const client = new SpotifyClient(target, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url === 'https://accounts.spotify.com/api/token') {
        return json({ access_token: 'access-new', expires_in: 3600 });
      }
      return json({ ok: true });
    },
  });

  await client.get('/me');

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://accounts.spotify.com/api/token');
  const body = requests[0].options.body;
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'refresh-old');
  assert.equal(body.get('client_id'), '0123456789abcdef0123456789abcdef');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer access-new');
  assert.equal(target.tokens.access_token, 'access-new');
  assert.ok(target.tokens.expires_at > Date.now());
});

test('refreshes once when the API rejects the token', async () => {
  const requests = [];
  const client = new SpotifyClient(session(), {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url === 'https://accounts.spotify.com/api/token') {
        return json({ access_token: 'access-new', expires_in: 3600 });
      }
      const auth = options.headers.Authorization;
      return auth === 'Bearer access-new' ? json({ ok: true }) : json({ error: {} }, 401);
    },
  });

  assert.deepEqual(await client.get('/me'), { ok: true });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].url, 'https://accounts.spotify.com/api/token');
  assert.equal(requests[2].options.headers.Authorization, 'Bearer access-new');
});

test('serializes concurrent token refreshes', async () => {
  let tokenCalls = 0;
  const target = session({ expires_at: 0 });
  const client = new SpotifyClient(target, {
    fetchImpl: async (url) => {
      if (url === 'https://accounts.spotify.com/api/token') {
        tokenCalls += 1;
        return json({ access_token: 'access-new', expires_in: 3600 });
      }
      return json({ ok: true });
    },
  });

  await Promise.all([client.get('/me/tracks'), client.get('/me/albums')]);
  assert.equal(tokenCalls, 1);
});

test('retries after a rate limit', async () => {
  let apiCalls = 0;
  const client = new SpotifyClient(session(), {
    fetchImpl: async () => {
      apiCalls += 1;
      if (apiCalls === 1) return json({ error: {} }, 429, { 'Retry-After': '0.01' });
      return json({ ok: true });
    },
  });

  assert.deepEqual(await client.get('/me'), { ok: true });
  assert.equal(apiCalls, 2);
});

test('fails promptly when a Spotify request times out', async () => {
  let calls = 0;
  const client = new SpotifyClient(session(), {
    fetchImpl: async (url, { signal }) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    timeoutMs: 20,
    maxDurationMs: 100,
    maxRetries: 3,
  });

  const started = Date.now();
  await assert.rejects(
    () => client.get('/me'),
    (error) => {
      assert.ok(error instanceof SpotifyError);
      assert.equal(error.status, 504);
      return true;
    }
  );
  assert.equal(calls, 1, 'timed-out attempts should not be retried');
  assert.ok(Date.now() - started < 500);
});

test('does not sleep for an unbounded Retry-After', async () => {
  let calls = 0;
  const client = new SpotifyClient(session(), {
    fetchImpl: async () => {
      calls += 1;
      return json({ error: {} }, 429, { 'Retry-After': '5400' });
    },
    maxDurationMs: 1000,
    maxRetries: 2,
    maxRetryWaitMs: 20,
  });

  const started = Date.now();
  await assert.rejects(
    () => client.get('/me'),
    (error) => {
      assert.ok(error instanceof SpotifyError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 5400);
      assert.match(error.message, /Try again in 2 hours/);
      return true;
    }
  );
  assert.equal(calls, 3);
  assert.ok(Date.now() - started < 500);
});

test('throws a SpotifyError with the API message', async () => {
  const client = new SpotifyClient(session(), {
    fetchImpl: async () => json({ error: { message: 'Insufficient client scope' } }, 403),
  });

  await assert.rejects(
    () => client.get('/me/tracks'),
    (error) => {
      assert.ok(error instanceof SpotifyError);
      assert.equal(error.status, 403);
      assert.equal(error.message, 'Insufficient client scope');
      return true;
    }
  );
});

test('surfaces a 401 when the refresh token is dead', async () => {
  const client = new SpotifyClient(session({ expires_at: 0, refresh_token: 'dead' }), {
    fetchImpl: async () => json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400),
  });

  await assert.rejects(
    () => client.get('/me'),
    (error) => {
      assert.ok(error instanceof SpotifyError);
      assert.equal(error.status, 401);
      assert.match(error.message, /Refresh token revoked/);
      return true;
    }
  );
});

test('sends write requests and handles empty response bodies', async () => {
  const requests = [];
  const client = new SpotifyClient(session(), {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response('', { status: 200 });
    },
  });

  assert.equal(
    await client.request('/me/library?uris=spotify:track:track1', { method: 'DELETE' }),
    null
  );
  assert.equal(requests[0].options.method, 'DELETE');
  assert.equal(
    requests[0].url,
    'https://api.spotify.com/v1/me/library?uris=spotify:track:track1'
  );
});

test('handles 204 responses without trying to parse JSON', async () => {
  const client = new SpotifyClient(session(), {
    fetchImpl: async () => new Response(null, { status: 204 }),
  });

  assert.equal(await client.request('/me/library?uris=spotify:album:album1', { method: 'PUT' }), null);
});

test('encodes JSON bodies for non-GET requests', async () => {
  const requests = [];
  const client = new SpotifyClient(session(), {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 204 });
    },
  });

  await client.put('/me/albums', { body: { ids: ['album1'] } });

  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].options.body), { ids: ['album1'] });
});
