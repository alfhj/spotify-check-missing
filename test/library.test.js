import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeSavedItems,
  hasWriteScope,
  LibraryChangeError,
  normalizeIds,
  WRITE_SCOPE,
} from '../src/library.js';

class FakeClient {
  constructor() {
    this.calls = [];
  }

  async request(path, options = {}) {
    this.calls.push({ path, options });
    return null;
  }
}

const ids = (count) =>
  Array.from({ length: count }, (_, index) => String(index).padStart(22, '0'));

test('recognizes the write scope in a granted scope string', () => {
  assert.equal(hasWriteScope('user-library-read user-library-modify'), true);
  assert.equal(hasWriteScope('user-library-modify'), true);
  assert.equal(hasWriteScope('user-library-read user-read-private'), false);
  assert.equal(hasWriteScope(''), false);
  assert.equal(hasWriteScope(undefined), false);
  assert.equal(WRITE_SCOPE, 'user-library-modify');
});

test('deduplicates Spotify IDs and rejects invalid values', () => {
  const [first, second] = ids(2);

  assert.deepEqual(normalizeIds([first, first, ` ${second} `]), [first, second]);

  assert.throws(() => normalizeIds('not-an-array'), LibraryChangeError);
  assert.throws(() => normalizeIds([]), LibraryChangeError);
  assert.throws(() => normalizeIds([first, 'short']), LibraryChangeError);
});

test('saves tracks with PUT requests in batches of 40', async () => {
  const client = new FakeClient();
  const trackIds = ids(75);

  const updated = await changeSavedItems(client, {
    kind: 'tracks',
    action: 'save',
    ids: trackIds,
  });

  assert.equal(updated, 75);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].options.method, 'PUT');
  assert.equal(client.calls[1].options.method, 'PUT');
  assert.ok(client.calls[0].path.startsWith('/me/library?uris='));
  assert.ok(client.calls[1].path.startsWith('/me/library?uris='));

  const firstBatch = new URL(client.calls[0].path, 'https://api.spotify.com').searchParams
    .get('uris')
    .split(',');
  const secondBatch = new URL(client.calls[1].path, 'https://api.spotify.com').searchParams
    .get('uris')
    .split(',');

  assert.equal(firstBatch.length, 40);
  assert.equal(secondBatch.length, 35);
  assert.deepEqual([...firstBatch, ...secondBatch], trackIds.map((id) => `spotify:track:${id}`));
});

test('removes albums with DELETE requests', async () => {
  const client = new FakeClient();
  const albumIds = ids(2);

  const updated = await changeSavedItems(client, {
    kind: 'albums',
    action: 'remove',
    ids: albumIds,
  });

  assert.equal(updated, 2);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].options.method, 'DELETE');
  assert.ok(client.calls[0].path.startsWith('/me/library?uris='));
  const uris = new URL(client.calls[0].path, 'https://api.spotify.com').searchParams
    .get('uris')
    .split(',');
  assert.deepEqual(uris, albumIds.map((id) => `spotify:album:${id}`));
});

test('rejects unknown item types and actions', async () => {
  const client = new FakeClient();
  const [id] = ids(1);

  await assert.rejects(
    () => changeSavedItems(client, { kind: 'artists', action: 'save', ids: [id] }),
    LibraryChangeError
  );
  await assert.rejects(
    () => changeSavedItems(client, { kind: 'tracks', action: 'toggle', ids: [id] }),
    LibraryChangeError
  );
  assert.equal(client.calls.length, 0);
});
