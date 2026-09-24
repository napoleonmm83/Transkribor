'use strict'
// AIRLOCK-OHNE-PLANWERKZEUG: Plan im Gespraech vorgelegt, #530 vom Nutzer beauftragt; update_plan fehlt.

const { randomUUID } = require('crypto')
const fehlerberichte = require('./fehlerberichte')
const bericht = require('./bericht')

function vorschau(text, ctx, meta) {
  const maske = { ...ctx, namen: fehlerberichte.namen(ctx.projekte) }
  return {
    id: randomUUID(),
    kopf: bericht.kopf(meta).map(z => fehlerberichte.maskiere(z, maske)),
    zeilen: fehlerberichte.protokollZeilen(text, maske),
  }
}

function envelopeUrl(dsn) {
  if (!dsn) throw new Error('Bugsink ist in dieser Fassung nicht eingerichtet.')
  let u
  try { u = new URL(dsn) } catch { throw new Error('Bugsink-Adresse ist ungueltig.') }
  if (!['http:', 'https:'].includes(u.protocol) || !u.username || !u.pathname.match(/\/\d+\/?$/)) {
    throw new Error('Bugsink-Adresse ist ungueltig.')
  }
  const teile = u.pathname.split('/').filter(Boolean)
  const projekt = teile.pop()
  const key = decodeURIComponent(u.username)
  u.username = ''
  u.password = ''
  u.pathname = `/${teile.length ? teile.join('/') + '/' : ''}api/${projekt}/envelope/`
  u.search = new URLSearchParams({ sentry_version: '7', sentry_key: key }).toString()
  u.hash = ''
  return u.toString()
}

function ereignis(snapshot, indices, kommentar, meta, ctx) {
  if (!Array.isArray(indices) || indices.some(i => !Number.isInteger(i) || i < 0 || i >= snapshot.zeilen.length)
    || new Set(indices).size !== indices.length) throw new Error('Auswahl der Protokollzeilen ist ungueltig.')
  if (typeof kommentar !== 'string' || kommentar.length > 2000) throw new Error('Kommentar ist zu lang oder ungueltig.')
  const maskierterKommentar = fehlerberichte.maskiere(kommentar, { ...ctx, namen: fehlerberichte.namen(ctx.projekte) })
  return {
    event_id: snapshot.id.replace(/-/g, ''), timestamp: Date.now() / 1000,
    platform: 'node', level: 'info', message: 'Manueller Fehlerbericht',
    release: `transkribor@${meta.version}`, environment: meta.gepackt ? 'gepackt' : 'dev',
    extra: { system: snapshot.kopf, protokoll: indices.map(i => snapshot.zeilen[i]), kommentar: maskierterKommentar },
  }
}

// Weder `electron.net.request` im SDK-Transport noch `createTransport` setzen eine Frist: ein
// Server, der annimmt und nie antwortet, liess den Dialog sonst bis zum Neustart haengen.
const FRIST_MS = 30000

async function senden({ dsn, snapshot, indices, kommentar, meta, ctx, transport, frist = FRIST_MS }) {
  const url = envelopeUrl(dsn)
  const event = ereignis(snapshot, indices, kommentar, meta, ctx)
  let uhr
  const antwort = await Promise.race([
    transport({ url, recordDroppedEvent: () => {} }).send([
      { event_id: event.event_id, sent_at: new Date().toISOString() },
      [[{ type: 'event' }, event]],
    ]),
    new Promise((_, nein) => { uhr = setTimeout(() => nein(new Error('Bugsink antwortet nicht. Bitte spaeter erneut versuchen.')), frist) }),
  ]).finally(() => clearTimeout(uhr))
  if (!antwort || !Number.isInteger(antwort.statusCode)
    || antwort.statusCode < 200 || antwort.statusCode >= 300) {
    throw new Error('Bugsink hat den Bericht nicht bestaetigt. Bitte spaeter erneut versuchen.')
  }
  return { id: snapshot.id }
}

module.exports = { vorschau, envelopeUrl, ereignis, senden }
