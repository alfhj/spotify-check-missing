const PAGE_SIZE = 50;
const PAGE_CONCURRENCY = 4;

/** A spotify paging object's `next` URL is followed until the list is complete. */
async function fetchAllPages(client, path, { onPage } = {}) {
  const first = await client.get(`${path}?limit=${PAGE_SIZE}&offset=0`);
  const total = Number(first?.total ?? first?.items?.length ?? 0);
  const items = [...(first?.items ?? [])];
  onPage?.({ fetched: items.length, total });

  const offsets = [];
  for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) {
    offsets.push(offset);
  }

  await mapLimit(offsets, PAGE_CONCURRENCY, async (offset) => {
    const page = await client.get(`${path}?limit=${PAGE_SIZE}&offset=${offset}`);
    if (Array.isArray(page?.items)) items.push(...page.items);
    onPage?.({ fetched: items.length, total });
  });

  return { items, total };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function pickImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (a?.width ?? 0) - (b?.width ?? 0));
  const preferred = sorted.find((image) => (image?.width ?? 0) >= 240) ?? sorted.at(-1);
  return preferred?.url ?? null;
}

function normalizeAlbum(album = {}) {
  return {
    id: album.id ?? null,
    name: album.name || 'Unknown album',
    artists: (album.artists ?? []).map((artist) => artist?.name).filter(Boolean),
    image: pickImage(album.images),
    url:
      album.external_urls?.spotify ??
      (album.id ? `https://open.spotify.com/album/${album.id}` : null),
    releaseDate: album.release_date ?? null,
  };
}

function normalizeTrack(track = {}, addedAt = null) {
  return {
    id: track.id ?? null,
    name: track.name || 'Unknown track',
    artists: (track.artists ?? []).map((artist) => artist?.name).filter(Boolean),
    durationMs: Number(track.duration_ms ?? 0),
    trackNumber: Number(track.track_number ?? 0),
    discNumber: Number(track.disc_number ?? 1),
    explicit: Boolean(track.explicit),
    url:
      track.external_urls?.spotify ??
      (track.id ? `https://open.spotify.com/track/${track.id}` : null),
    addedAt,
  };
}

function compareText(a = '', b = '') {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function compareAlbums(a, b) {
  return (
    compareText(a.album.artists[0] ?? '', b.album.artists[0] ?? '') ||
    compareText(a.album.name, b.album.name)
  );
}

function trackOrder(a, b) {
  return a.discNumber - b.discNumber || a.trackNumber - b.trackNumber || compareText(a.name, b.name);
}

/** Fetch every track of an album, following paging and repairing short responses. */
async function getAlbumTracks(client, album) {
  const collection = album.tracks;
  if (!collection || !Array.isArray(collection.items)) {
    return fetchTrackPages(client, `/albums/${album.id}/tracks`);
  }

  const items = [...collection.items];
  let next = collection.next;
  while (next) {
    const page = await client.get(next);
    if (Array.isArray(page?.items)) items.push(...page.items);
    next = page?.next ?? null;
  }

  const total = Math.max(
    Number(collection.total ?? 0),
    Number(album.total_tracks ?? 0),
    items.length
  );
  if (items.length < total) {
    let page = await client.get(
      `/albums/${album.id}/tracks?limit=${PAGE_SIZE}&offset=${items.length}`
    );
    if (Array.isArray(page?.items)) items.push(...page.items);
    next = page?.next ?? null;
    while (next) {
      page = await client.get(next);
      if (Array.isArray(page?.items)) items.push(...page.items);
      next = page?.next ?? null;
    }
  }

  return items;
}

async function fetchTrackPages(client, path) {
  const items = [];
  let next = `${path}${path.includes('?') ? '&' : '?'}limit=${PAGE_SIZE}`;
  while (next) {
    const page = await client.get(next);
    if (Array.isArray(page?.items)) items.push(...page.items);
    next = page?.next ?? null;
  }
  return items;
}

/**
 * Build the diff between a Spotify user's liked songs and their liked albums.
 *
 * A "missing liked song" is a track from a liked album whose track ID is not
 * in the user's Liked Songs. A "missing album like" is an album that one of
 * the user's liked songs belongs to, but which is not saved to Liked Albums.
 */
export async function analyzeLibrary(
  client,
  { onProgress = () => {}, profile: knownProfile = null } = {}
) {
  const startedAt = Date.now();
  const progress = (update) => {
    try {
      onProgress(update);
    } catch {
      // Progress reporting must never break the analysis.
    }
  };

  progress({ phase: 'profile', message: 'Loading your Spotify profile…' });
  // Reuse the profile from /api/me when available: fewer calls means fewer
  // chances to trip Spotify's rate limit.
  const profile = knownProfile ?? (await client.get('/me'));

  progress({ phase: 'likedSongs', fetched: 0, message: 'Loading your liked songs…' });
  const savedTracks = await fetchAllPages(client, '/me/tracks', {
    onPage: ({ fetched, total }) =>
      progress({
        phase: 'likedSongs',
        fetched,
        total,
        message: `Loading liked songs (${fetched.toLocaleString()} of ${total.toLocaleString()})…`,
      }),
  });

  progress({ phase: 'likedAlbums', fetched: 0, message: 'Loading your liked albums…' });
  const savedAlbums = await fetchAllPages(client, '/me/albums', {
    onPage: ({ fetched, total }) =>
      progress({
        phase: 'likedAlbums',
        fetched,
        total,
        message: `Loading liked albums (${fetched.toLocaleString()} of ${total.toLocaleString()})…`,
      }),
  });

  const likedTrackIds = new Set();
  let localFilesSkipped = 0;
  let unavailableSongs = 0;

  for (const item of savedTracks.items) {
    const track = item?.track;
    if (!track) {
      unavailableSongs += 1;
      continue;
    }
    if (track.is_local || !track.id) {
      localFilesSkipped += 1;
      continue;
    }
    likedTrackIds.add(track.id);
  }

  /** @type {Map<string, any>} */
  const likedAlbums = new Map();
  for (const item of savedAlbums.items) {
    const album = item?.album;
    if (album?.id) likedAlbums.set(album.id, album);
  }
  const likedAlbumIds = new Set(likedAlbums.keys());

  // Saved album objects already carry their track lists, so the audit normally
  // needs no extra requests. Follow paging (or fall back to the album tracks
  // endpoint) only for long albums or responses without an embedded track list.
  const albumIds = [...likedAlbumIds];
  const albumTrackLists = new Map();
  const unavailableAlbumIds = new Set();
  let completedAlbums = 0;
  const progressStep = Math.max(1, Math.ceil(albumIds.length / 50));

  progress({
    phase: 'albumTracks',
    fetched: 0,
    total: albumIds.length,
    message:
      albumIds.length === 0
        ? 'No liked albums to scan.'
        : `Reading liked albums (0 of ${albumIds.length.toLocaleString()})…`,
  });

  await mapLimit(albumIds, 4, async (albumId) => {
    const album = likedAlbums.get(albumId);
    try {
      albumTrackLists.set(albumId, await getAlbumTracks(client, album));
    } catch (error) {
      if ([400, 403, 404].includes(error?.status)) {
        unavailableAlbumIds.add(albumId);
      } else {
        throw error;
      }
    }

    completedAlbums += 1;
    if (completedAlbums % progressStep === 0 || completedAlbums === albumIds.length) {
      progress({
        phase: 'albumTracks',
        fetched: completedAlbums,
        total: albumIds.length,
        message: `Reading liked albums (${completedAlbums.toLocaleString()} of ${albumIds.length.toLocaleString()})…`,
      });
    }
  });

  progress({ phase: 'compare', message: 'Comparing your library…' });

  // 1. Tracks in liked albums that are missing from Liked Songs.
  /** @type {Array<{ album: any, totalTracks: number, likedTracks: number, missingTracks: number, tracks: any[] }>} */
  const albumsWithMissingSongs = [];
  const uniqueMissingTrackIds = new Set();
  let missingSongInstances = 0;
  let albumTracksScanned = 0;

  for (const [albumId, trackList] of albumTrackLists) {
    const album = likedAlbums.get(albumId);
    const seen = new Set();
    const missing = [];

    for (const track of trackList) {
      if (!track || !track.id || track.is_local) continue;
      if (track.type && track.type !== 'track') continue;
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      if (likedTrackIds.has(track.id)) continue;

      missing.push(normalizeTrack(track));
      uniqueMissingTrackIds.add(track.id);
    }

    const totalTracks = seen.size;
    albumTracksScanned += totalTracks;
    if (missing.length === 0) continue;

    missing.sort(trackOrder);
    missingSongInstances += missing.length;
    albumsWithMissingSongs.push({
      album: normalizeAlbum(album),
      totalTracks,
      likedTracks: totalTracks - missing.length,
      missingTracks: missing.length,
      tracks: missing,
    });
  }

  albumsWithMissingSongs.sort(
    (a, b) => b.missingTracks - a.missingTracks || compareAlbums(a, b)
  );

  // 2. Liked songs whose album is not saved to Liked Albums.
  /** @type {Map<string, { album: any, songs: any[] }>} */
  const albumsMissingLikes = new Map();

  for (const item of savedTracks.items) {
    const track = item?.track;
    if (!track || track.is_local || !track.id) continue;
    const album = track.album;
    if (!album?.id || likedAlbumIds.has(album.id)) continue;

    let group = albumsMissingLikes.get(album.id);
    if (!group) {
      group = { album: normalizeAlbum(album), songs: [] };
      albumsMissingLikes.set(album.id, group);
    }
    group.songs.push(normalizeTrack(track, item.added_at ?? null));
  }

  const unlikedAlbumGroups = [...albumsMissingLikes.values()];
  for (const group of unlikedAlbumGroups) {
    group.songs.sort(trackOrder);
  }
  unlikedAlbumGroups.sort(
    (a, b) => b.songs.length - a.songs.length || compareAlbums(a, b)
  );

  const likedSongsInUnlikedAlbums = unlikedAlbumGroups.reduce(
    (total, group) => total + group.songs.length,
    0
  );

  // The server's session profile is already normalized; the raw /me response
  // is not. Accept both shapes.
  const normalizedProfile = profile?.displayName
    ? {
        id: profile.id ?? null,
        displayName: profile.displayName || profile.id || 'Spotify user',
        image: profile.image ?? null,
        url: profile.url ?? null,
        product: profile.product ?? null,
      }
    : {
        id: profile?.id ?? null,
        displayName: profile?.display_name || profile?.id || 'Spotify user',
        image: pickImage(profile?.images),
        url:
          profile?.external_urls?.spotify ??
          (profile?.id ? `https://open.spotify.com/user/${profile.id}` : null),
        product: profile?.product ?? null,
      };

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    profile: normalizedProfile,
    stats: {
      likedSongs: savedTracks.total,
      likedAlbums: likedAlbums.size,
      albumTracks: albumTracksScanned,
      missingSongs: uniqueMissingTrackIds.size,
      missingSongInstances,
      albumsWithMissingSongs: albumsWithMissingSongs.length,
      unlikedAlbums: unlikedAlbumGroups.length,
      likedSongsInUnlikedAlbums,
      unavailableAlbums: unavailableAlbumIds.size,
      localFilesSkipped,
      unavailableSongs,
    },
    albumsWithMissingSongs,
    unlikedAlbumGroups,
  };
}
