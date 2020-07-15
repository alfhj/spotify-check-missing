const axios = require('axios')
// const promise = require('bluebird')
const fs = require('fs')

const token = 'BQDh-Lqfnxkn7cG5K5GBDMP1uKcqPWjrRd6ME9sSMUYUw47cZeO1x0mVyxa2nibn_V3C5DR0Qzms_vfc4iRde42B9rLEyCYHyIIsJzdekmzMXfOCO-f9oaBpbGNw2xWMpQFG1f35Vux_b7i0U2YwZyeTWdZIppE3iCGbSJ8I_HBe73M4sqxCuqmr8ozehfKbO9-3ZkdiG0sRXrzFw4SrVhIaugiQfsOkMm0rZzzJ6OEIvVn-ltE'
const urlBase = 'https://api.spotify.com/v1/me'
// const apiMaxItems = 50
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

// const compareSaved = (songs, albums)

const readFileIfExists = (path) => {
  if (fs.existsSync(path)) {
    const data = fs.readFileSync(path)
    return JSON.parse(data)
  }
}

const run = async () => {
  console.log('Getting liked songs...')
  const tracks = readFileIfExists('tracks.json') ||
    (await getItems(`${urlBase}/tracks`, true)).map(t => t.track)

  console.log('Getting albums...')
  const partialAlbums = readFileIfExists('albums.json') ||
    (await getItems(`${urlBase}/albums`, true)).map(a => a.album)

  console.log('Getting missing album tracks...')
  const albums = await Promise.all(partialAlbums.map(async a => {
    const albumTracks = a.tracks && a.tracks.total > a.tracks.limit
      ? await getItems(a.tracks.href, false)
      : a.tracks.items
    a.tracks = albumTracks
    return a
  }))

  // const data = JSON.stringify(tracks)
  // fs.writeFile('songs.json', data, (err) => err && console.log(err))
  console.log('Done!')
}

run()
