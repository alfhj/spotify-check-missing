const axios = require('axios')
const promise = require('bluebird')
const fs = require('fs')

const token = 'BQDj5QhW--gfhqZJXybydoZ-XWU8wUW49PDb65EiygBm39-Q77kysw5EUuoUlasL4yGM2A3Snqh7MAsjfadwqIPZMrvK6P5zoN4rOTA9HsvfmPbTlLwK7VLZ0Q1Cp_3zr-kezpjOyvZg-0PGu_HACSauyJ4_AaM1isaYN2pARgQA5Gm-M08S1DxesvkiNfNWoW-0ZVpOfJxPo3dfvSnRj3JdRqL0gTczDe97SXTBu2WMT6-Ha24'
const urlBase = 'https://api.spotify.com/v1/me'
const apiMaxItems = 50
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

const getTotal = async () => await axios.get(`${urlBase}/tracks`, {
  params: {
    limit: 1
  },
  headers: apiHeaders
})
  .then((res) => res.data.total)
  .catch((error) => printError(error))

const getItemsPage = async (offset) => await axios.get(`${urlBase}/tracks`, {
  params: {
    limit: apiMaxItems,
    offset
  },
  headers: apiHeaders
})
  .then((res) => res.data.items)
  .catch((error) => printError(error))

const run = async () => {
  const total = await getTotal()
  const songs = []
  for (let i = 0; i < total; i += apiMaxItems) {
    console.log(`Getting song ${i} of ${total}`)
    const newSongs = await getItemsPage(i)
    songs.push(...newSongs)
  }
  console.log(songs)
  const data = JSON.stringify(songs)
  fs.writeFile('songs.json', data, (err) => err && console.log(err))
}

run()
