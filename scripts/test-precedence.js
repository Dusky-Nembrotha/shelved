// An import must correct an older import, but never a hand-typed rating.
import { applyRecords } from '../server/importers/apply.js'
import { record } from '../server/importers/shared.js'
import { all, get, run } from '../server/lib/db.js'

const mk = (rating, source) => record({
  type: 'film', title: 'Precedence Test', year: 2020, rating,
  consumed_on: '2024-05-01', merge: true, external_key: `${source}:test:precedence`,
})

applyRecords([mk(2, 'oldimport')], { source: 'oldimport', enrich: false })
console.log('  after first import:      ', get("SELECT rating FROM entries WHERE external_key LIKE '%precedence%'").rating, '(expected 2)')

applyRecords([mk(4.5, 'newimport')], { source: 'newimport', enrich: false })
const afterSecond = get("SELECT rating, source FROM entries e JOIN works w ON w.id=e.work_id WHERE w.title='Precedence Test'")
console.log('  after a fresher import:  ', afterSecond.rating, afterSecond.rating === 4.5 ? '✓ corrected' : '✗ stale value kept')

// Now pretend you edited it by hand, then re-import the old file.
run("UPDATE entries SET rating = 5, source = 'manual' WHERE work_id = (SELECT id FROM works WHERE title='Precedence Test')")
applyRecords([mk(2, 'oldimport')], { source: 'oldimport', enrich: false })
const afterManual = get("SELECT rating FROM entries e JOIN works w ON w.id=e.work_id WHERE w.title='Precedence Test'")
console.log('  after re-import over hand edit:', afterManual.rating, afterManual.rating === 5 ? '✓ your edit survived' : '✗ OVERWRITTEN')

for (const w of all("SELECT id FROM works WHERE title='Precedence Test'")) run('DELETE FROM works WHERE id = ?', w.id)
