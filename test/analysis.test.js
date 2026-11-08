import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLibrary } from '../src/analysis.js';

const PROFILE = {
  id: 'user1',
  display_name: 'Test User',
  images: [{ url: 'https://image/avatar.jpg', width: 300 }],
  external_urls: { spotify: 'https://open.spotify.com/user/user1' },
  product: 'free',
};

function makeAlbum(id, name = `Album ${id}`, artist = 'Artist') {
  return {
    id,
    name,
    artists: [{ id: 'artist1', name: artist }],
    images: [{ url: `https://image/${id}.jpg`, width: 300 }],
    release_date: '2020-05-01',
    external_urls: { spotify: `https://open.spotify.com/album/${id}` },
  };
}

function makeTrack(id, name, albumId, number = 1, extra = {}) {
  return {
    id,
    name,
    type: 'track',
    is_local: false,
    duration_ms: 180_000,
    track_number: number,
    disc_number: 1,
    artists: [{ id: 'artist1', name: 'Artist' }],
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    album: makeAlbum(albumId),
    ...extra,
  };
}

function paging(items, offset, limit, baseUrl) {
  const nextOffset = offset + limit;
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
    next: nextOffset < items.length ? `${baseUrl}?offset=${nextOffset}&limit=${limit}` : null,
  };
}

class FakeSpotify {
  constructor({ savedTracks = [], savedAlbums = [], albumTracks = {}, pageSize = 50 }) {
    this.savedTracks = savedTracks;
    this.savedAlbums = savedAlbums;
    this.albumTracks = albumTracks;
    this.pageSize = pageSize;
    this.calls = [];
  }

  async get(pathOrUrl) {
    const url = new URL(pathOrUrl, 'https://api.spotify.com');
    const pathname = url.pathname.replace(/^\/v1(?=\/)/, '');
    this.calls.push(pathname + url.search);

    if (pathname === '/me') return PROFILE;

    if (pathname === '/me/tracks') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? this.pageSize);
      return paging(
        this.savedTracks,
        offset,
        Math.min(limit, this.pageSize),
        'https://api.spotify.com/v1/me/tracks'
      );
    }

    if (pathname === '/me/albums') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? this.pageSize);
      return paging(
        this.savedAlbums,
        offset,
        Math.min(limit, this.pageSize),
        'https://api.spotify.com/v1/me/albums'
      );
    }

    if (pathname === '/albums') {
      throw new Error('The removed batch albums endpoint must not be used');
    }

    const albumTracksMatch = pathname.match(/^\/albums\/([^/]+)\/tracks$/);
    if (albumTracksMatch) {
      const id = decodeURIComponent(albumTracksMatch[1]);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return paging(
        this.albumTracks[id] ?? [],
        offset,
        limit,
        `https://api.spotify.com/v1/albums/${id}/tracks`
      );
    }

    throw new Error(`Unexpected Spotify path: ${pathname}`);
  }
}

const saved = (track, addedAt = '2024-01-01T00:00:00Z') => ({ added_at: addedAt, track });
const savedAlbum = (
  album,
  tracks,
  { trackPageSize = 50, omitTracks = false } = {}
) => {
  const savedEntry = {
    added_at: '2024-01-01T00:00:00Z',
    album: { ...album, total_tracks: tracks.length },
  };
  if (!omitTracks) {
    savedEntry.album.tracks = paging(
      tracks,
      0,
      trackPageSize,
      `https://api.spotify.com/v1/albums/${album.id}/tracks`
    );
  }
  return savedEntry;
};

test('separates missing song likes from unliked albums', async () => {
  const albumA = makeAlbum('albumA', 'Album A');
  const albumB = makeAlbum('albumB', 'Album B');
  const albumC = makeAlbum('albumC', 'Album C');

  const a1 = makeTrack('a1', 'A One', 'albumA', 1);
  const a2 = makeTrack('a2', 'A Two', 'albumA', 2);
  const a3 = makeTrack('a3', 'A Three', 'albumA', 3);
  const b1 = makeTrack('b1', 'B One', 'albumB', 1);
  const b2 = makeTrack('b2', 'B Two', 'albumB', 2);
  const c1 = makeTrack('c1', 'C One', 'albumC', 1);

  const client = new FakeSpotify({
    savedTracks: [saved(a1), saved(b2), saved(c1)],
    savedAlbums: [savedAlbum(albumA, [a1, a2, a3]), savedAlbum(albumB, [b1, b2])],
    albumTracks: {
      albumA: [a1, a2, a3],
      albumB: [b1, b2],
    },
  });

  const result = await analyzeLibrary(client);

  assert.equal(result.stats.likedSongs, 3);
  assert.equal(result.stats.likedAlbums, 2);
  assert.equal(result.stats.albumTracks, 5);
  assert.equal(result.stats.missingSongs, 3);
  assert.equal(result.stats.missingSongInstances, 3);
  assert.equal(result.stats.albumsWithMissingSongs, 2);
  assert.equal(result.stats.unlikedAlbums, 1);
  assert.equal(result.stats.likedSongsInUnlikedAlbums, 1);

  const missingByAlbum = Object.fromEntries(
    result.albumsWithMissingSongs.map((group) => [group.album.id, group])
  );
  assert.deepEqual(
    missingByAlbum.albumA.tracks.map((track) => track.id),
    ['a2', 'a3']
  );
  assert.equal(missingByAlbum.albumA.likedTracks, 1);
  assert.equal(missingByAlbum.albumB.missingTracks, 1);

  assert.equal(result.unlikedAlbumGroups[0].album.id, 'albumC');
  assert.deepEqual(
    result.unlikedAlbumGroups[0].songs.map((song) => song.id),
    ['c1']
  );
});

test('loads every page of liked songs and liked albums', async () => {
  const savedTracks = [];
  for (let index = 0; index < 120; index += 1) {
    savedTracks.push(saved(makeTrack(`track${index}`, `Track ${index}`, 'albumBig', index + 1)));
  }

  const albumTracks = {};
  const savedAlbums = [];
  for (let index = 0; index < 55; index += 1) {
    const albumId = `album${index}`;
    albumTracks[albumId] = [makeTrack(`${albumId}-t1`, `${albumId} Track 1`, albumId, 1)];
    savedAlbums.push(savedAlbum(makeAlbum(albumId), albumTracks[albumId]));
  }

  const client = new FakeSpotify({ savedTracks, savedAlbums, albumTracks, pageSize: 50 });
  const progress = [];
  const result = await analyzeLibrary(client, { onProgress: (update) => progress.push(update) });

  assert.equal(result.stats.likedSongs, 120);
  assert.equal(result.stats.likedAlbums, 55);
  assert.equal(result.stats.albumTracks, 55);
  assert.equal(result.stats.missingSongs, 55);

  assert.ok(
    !client.calls.some((call) => call.startsWith('/albums')),
    'embedded saved-album tracks should not trigger extra album requests'
  );

  assert.ok(progress.some((update) => update.phase === 'likedSongs' && update.total === 120));
  assert.ok(progress.some((update) => update.phase === 'likedAlbums' && update.total === 55));
  assert.ok(progress.some((update) => update.phase === 'albumTracks'));
});

test('follows album track pagination and dedupes repeated track ids', async () => {
  const album = makeAlbum('albumLong', 'Long Album');
  const tracks = [];
  for (let index = 0; index < 60; index += 1) {
    tracks.push(makeTrack(`long${index}`, `Long ${index}`, 'albumLong', index + 1));
  }
  // A duplicated row must not be reported twice.
  tracks.push(tracks[0]);

  const client = new FakeSpotify({
    savedTracks: [],
    savedAlbums: [savedAlbum(album, tracks)],
    albumTracks: { albumLong: tracks },
  });

  const result = await analyzeLibrary(client);

  assert.equal(result.stats.albumTracks, 60);
  assert.equal(result.stats.missingSongs, 60);
  assert.equal(result.albumsWithMissingSongs[0].missingTracks, 60);
  assert.ok(
    client.calls.some((call) => call.includes('/albums/albumLong/tracks?offset=50')),
    'expected the analysis to request the next album track page'
  );
});

test('falls back to the album tracks endpoint when a saved album has no track list', async () => {
  const album = makeAlbum('fallbackAlbum');
  const tracks = [
    makeTrack('f1', 'Fallback One', 'fallbackAlbum', 1),
    makeTrack('f2', 'Fallback Two', 'fallbackAlbum', 2),
  ];
  const client = new FakeSpotify({
    savedTracks: [],
    savedAlbums: [savedAlbum(album, tracks, { omitTracks: true })],
    albumTracks: { fallbackAlbum: tracks },
  });

  const result = await analyzeLibrary(client);

  assert.equal(result.stats.albumTracks, 2);
  assert.equal(result.stats.missingSongs, 2);
  assert.ok(
    client.calls.some((call) => call.startsWith('/albums/fallbackAlbum/tracks')),
    'expected a fallback request to the still-supported album tracks endpoint'
  );
});

test('skips local files and unavailable saved items', async () => {
  const album = makeAlbum('albumA');
  const localTrack = makeTrack('local1', 'Local Song', 'albumA', 1, {
    id: null,
    is_local: true,
    album: { ...makeAlbum('albumA'), id: null },
  });

  const client = new FakeSpotify({
    savedTracks: [saved(localTrack), { added_at: '2024-01-01', track: null }],
    savedAlbums: [savedAlbum(album, [])],
    albumTracks: { albumA: [] },
  });

  const result = await analyzeLibrary(client);

  assert.equal(result.stats.likedSongs, 2);
  assert.equal(result.stats.localFilesSkipped, 1);
  assert.equal(result.stats.unavailableSongs, 1);
  assert.equal(result.stats.likedSongsInUnlikedAlbums, 0);
  assert.equal(result.stats.missingSongs, 0);
});

test('groups unliked albums by album and sorts their songs', async () => {
  const albumX = makeAlbum('albumX', 'X Album', 'X Artist');
  const t2 = makeTrack('x2', 'Second', 'albumX', 2);
  const t1 = makeTrack('x1', 'First', 'albumX', 1);

  const client = new FakeSpotify({
    savedTracks: [saved(t2), saved(t1)],
    savedAlbums: [],
    albumTracks: {},
  });

  const result = await analyzeLibrary(client);

  assert.equal(result.stats.unlikedAlbums, 1);
  assert.equal(result.stats.likedSongsInUnlikedAlbums, 2);
  assert.deepEqual(
    result.unlikedAlbumGroups[0].songs.map((track) => track.id),
    ['x1', 'x2']
  );
  assert.equal(result.unlikedAlbumGroups[0].album.name, 'Album albumX');
  assert.equal(result.unlikedAlbumGroups[0].album.image, 'https://image/albumX.jpg');
});

test('returns an empty, in-sync result for an empty library', async () => {
  const client = new FakeSpotify({ savedTracks: [], savedAlbums: [], albumTracks: {} });
  const result = await analyzeLibrary(client);

  assert.equal(result.stats.likedSongs, 0);
  assert.equal(result.stats.likedAlbums, 0);
  assert.equal(result.stats.missingSongs, 0);
  assert.equal(result.stats.unlikedAlbums, 0);
  assert.deepEqual(result.albumsWithMissingSongs, []);
  assert.deepEqual(result.unlikedAlbumGroups, []);
});

test('reuses a provided profile instead of calling /me again', async () => {
  const client = new FakeSpotify({});
  const profile = {
    id: 'user1',
    displayName: 'Known User',
    image: 'https://image/known.jpg',
    url: 'https://open.spotify.com/user/user1',
    product: 'premium',
  };

  const result = await analyzeLibrary(client, { profile });

  assert.equal(client.calls.includes('/me'), false);
  assert.equal(result.profile.displayName, 'Known User');
  assert.equal(result.profile.image, 'https://image/known.jpg');
});
