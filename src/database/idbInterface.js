import { dbPromise } from './databaseLifecycle'
import {
  INDEX_COUNT,
  INDEX_GROUP_AND_ORDER, INDEX_TOKENS, KEY_ETAG, KEY_URL,
  MODE_READONLY, MODE_READWRITE,
  STORE_EMOJI, STORE_FAVORITES,
  STORE_KEYVALUE
} from './constants'
import { transformEmojiBaseData } from './utils/transformEmojiBaseData'
import { mark, stop } from '../shared/marks'
import { extractTokens } from './utils/extractTokens'

export async function isEmpty (db) {
  return !(await get(db, STORE_KEYVALUE, KEY_URL))
}

export async function hasData (db, url, eTag) {
  const [oldETag, oldUrl] = await get(db, STORE_KEYVALUE, [KEY_ETAG, KEY_URL])
  return (oldETag === eTag && oldUrl === url)
}

export async function loadData (db, emojiBaseData, url, eTag) {
  mark('loadData')
  try {
    const transformedData = transformEmojiBaseData(emojiBaseData)
    await dbPromise(db, [STORE_EMOJI, STORE_KEYVALUE], MODE_READWRITE, ([emojiStore, metaStore]) => {
      let oldETag
      let oldUrl
      let oldKeys
      let todo = 0

      function checkFetched () {
        if (++todo === 3) {
          onFetched()
        }
      }

      function onFetched () {
        if (oldETag === eTag && oldUrl === url) {
          // check again within the transaction to guard against concurrency, e.g. multiple browser tabs
          return
        }
        if (oldKeys.length) {
          for (const key of oldKeys) {
            emojiStore.delete(key)
          }
        }
        insertData()
      }

      function insertData () {
        for (const data of transformedData) {
          emojiStore.put(data)
        }
        metaStore.put(eTag, KEY_ETAG)
        metaStore.put(url, KEY_URL)
      }

      metaStore.get(KEY_ETAG).onsuccess = e => {
        oldETag = e.target.result
        checkFetched()
      }

      metaStore.get(KEY_URL).onsuccess = e => {
        oldUrl = e.target.result
        checkFetched()
      }

      emojiStore.getAllKeys().onsuccess = e => {
        oldKeys = e.target.result
        checkFetched()
      }
    })
  } finally {
    stop('loadData')
  }
}

export async function getEmojiByGroup (db, group) {
  return dbPromise(db, STORE_EMOJI, MODE_READONLY, (emojiStore, cb) => {
    const range = IDBKeyRange.bound([group, 0], [group + 1, 0], false, true)
    emojiStore.index(INDEX_GROUP_AND_ORDER).getAll(range).onsuccess = e => {
      cb(e.target.result)
    }
  })
}

export async function getEmojiBySearchQuery (db, query) {
  const tokens = extractTokens(query)
  return dbPromise(db, STORE_EMOJI, MODE_READONLY, (emojiStore, cb) => {
    // get all results that contain all tokens (i.e. an AND query)
    const intermediateResults = []

    const checkDone = () => {
      if (intermediateResults.length === tokens.length) {
        onDone()
      }
    }

    const onDone = () => {
      const results = []
      const shortestArray = intermediateResults.sort((a, b) => (a.length < b.length ? -1 : 1))[0]
      for (const item of shortestArray) {
        // if this item is included in every array in the intermediate results, add it to the final results
        if (!intermediateResults.some(array => array.findIndex(_ => _.unicode === item.unicode) === -1)) {
          results.push(item)
        }
      }
      cb(results.sort((a, b) => a.order < b.order ? -1 : 1))
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      const range = i === tokens.length - 1
        ? IDBKeyRange.bound(token, token + '\uffff', false, true) // treat last token as a prefix search
        : IDBKeyRange.only(token) // treat all other tokens as an exact match
      emojiStore.index(INDEX_TOKENS).getAll(range).onsuccess = e => {
        intermediateResults.push(e.target.result)
        checkDone()
      }
    }
  })
}

export async function getEmojiByShortcode (db, shortcode) {
  const emojis = await getEmojiBySearchQuery(db, shortcode)
  return emojis.filter(_ => {
    const lowerShortcodes = _.shortcodes.map(_ => _.toLowerCase())
    return lowerShortcodes.includes(shortcode.toLowerCase())
  })[0] || null
}

export async function getEmojiByUnicode (db, unicode) {
  return dbPromise(db, STORE_EMOJI, MODE_READONLY, (emojiStore, cb) => {
    emojiStore.get(unicode).onsuccess = e => cb(e.target.result || null)
  })
}

export function get (db, storeName, key) {
  return dbPromise(db, storeName, MODE_READONLY, (store, cb) => {
    if (Array.isArray(key)) {
      const res = Array(key.length)
      let todo = 0
      for (let i = 0; i < key.length; i++) {
        store.get(key[i]).onsuccess = e => {
          res[i] = e.target.result
          if (++todo === key.length) {
            cb(res)
          }
        }
      }
    } else {
      store.get(key).onsuccess = e => cb(e.target.result)
    }
  })
}

export function set (db, storeName, key, value) {
  return dbPromise(db, storeName, MODE_READWRITE, (store, cb) => {
    store.put(value, key)
    cb()
  })
}

export function incrementFavoriteEmojiCount (db, unicode) {
  return dbPromise(db, STORE_FAVORITES, MODE_READWRITE, (store, cb) => {
    store.get(unicode).onsuccess = e => {
      const result = e.target.result || 0
      store.put(result + 1, unicode)
      cb()
    }
  })
}

export function getTopFavoriteEmoji (db, n) {
  if (n === 0) {
    return []
  }
  return dbPromise(db, [STORE_FAVORITES, STORE_EMOJI], MODE_READONLY, ([favoritesStore, emojiStore], cb) => {
    const results = []
    favoritesStore.index(INDEX_COUNT).openCursor(undefined, 'prev').onsuccess = e => {
      const cursor = e.target.result
      if (!cursor) {
        return cb(results)
      }
      // TODO: this could be optimized by doing the get and the cursor.continue() in parallel
      emojiStore.get(cursor.primaryKey).onsuccess = e => {
        const emoji = e.target.result
        if (emoji) {
          results.push(emoji)
          if (results.length === n) {
            return cb(results)
          }
        }
        cursor.continue()
      }
    }
  })
}
