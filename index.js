const axios = require('axios')
const prompt = require('prompt-sync')()

const token = prompt('Spotify API token: ')
const urlBase = 'https://api.spotify.com/v1/me'
const apiHeaders = {
  Authorization: `Bearer ${token}`
}

const printError = (error) => {
  if (error.response) {
    console.log(error.response.data)
    console.log(error.response.status)
    console.log(error.response.headers)
  } else if (error.request) {
    console.log(error.request)
  } else {
    console.log('Error', error.message)
  }
  console.log(error.config)
  throw new Error('Error')
}

const getItemsPage = async (url) => await axios.get(url, {
  params: {
    limit: 50
  },
  headers: apiHeaders
})
  .then((res) => res.data)
  .catch((error) => printError(error))

const getItems = async (url, log) => {
  let nextUrl = url
  const totalItems = []
  while (nextUrl) {
    const data = await getItemsPage(nextUrl)
    log && console.log(`Got item ${data.offset + data.items.length} of ${data.total}`)
    totalItems.push(...data.items)
    nextUrl = data.next
  }
  return totalItems
}

const compareTracksToAlbums = (tracks, albums) => tracks
  .filter(track => albums
    .every(album => !album.tracks
      .some(albumTrack => albumTrack.id === track.id)))
  .map(track => track.album)
  .reduce((total, current) => total
    .some(album => album && album.id === current.id)
    ? total
    : total.concat(current)
  , [])
  .map(album => album.name + ' (' + album.artists[0].name + ')')

const compareAlbumsToTracks = (tracks, albums) => albums
  .filter(album => album.tracks
    .some(albumTrack => !tracks
      .some(track => track.id === albumTrack.id)))
  .map(album => album.name + ' (' + album.artists[0].name + ')')

const run = async () => {
  console.log('Getting liked songs...')
  const tracks = (await getItems(`${urlBase}/tracks`, true)).map(t => t.track)

  console.log()
  console.log('Getting albums...')
  const partialAlbums = (await getItems(`${urlBase}/albums`, true)).map(a => a.album)

  console.log()
  console.log('Getting missing album tracks...')
  const albums = await Promise.all(partialAlbums.map(async album => {
    const albumTracks = album.tracks && album.tracks.total > album.tracks.limit
      ? await getItems(album.tracks.href, false)
      : album.tracks.items
    album.tracks = albumTracks
    return album
  }))

  console.log()
  console.log('Liked albums which contain songs not in library:')
  console.log(compareAlbumsToTracks(tracks, albums).join('\n'))

  console.log()
  console.log('Albums which contains liked tracks but have not been added to library:')
  console.log(compareTracksToAlbums(tracks, albums).join('\n'))
}

run()
