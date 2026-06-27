// =============================================================
//  Sonar — Baileys auth state backed by Postgres
//  Replaces useMultiFileAuthState (which spawns thousands of JSON
//  files). Creds + Signal keys are stored as rows in wa_auth.
// =============================================================
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys')
const store = require('./store')

async function usePostgresAuthState(sessionId) {
  const read = async (id) => {
    const raw = await store.waGet(sessionId, id)
    return raw ? JSON.parse(raw, BufferJSON.reviver) : null
  }
  const write = (id, value) => store.waSet(sessionId, id, JSON.stringify(value, BufferJSON.replacer))
  const del = (id) => store.waDel(sessionId, id)

  const creds = (await read('creds')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(ids.map(async (id) => {
            let value = await read(`${type}-${id}`)
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
            data[id] = value
          }))
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id]
              const key = `${type}-${id}`
              tasks.push(value ? write(key, value) : del(key))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: () => write('creds', creds),
    clear: () => store.waClear(sessionId),
  }
}

module.exports = { usePostgresAuthState }
