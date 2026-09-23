import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ACTION_GROUPS,
  ACTION_META,
  ACTIVITY_ACTIONS,
  ACTIVITY_MODULES,
  MAX_ACTIVITY_CHANGES,
  actionMeta,
  actionsOfCategory,
  actionsOfModule,
  actionsOfSeverity,
} from './activity.constants'
import type { ActivityModule } from './activity.constants'
import {
  changeSummary,
  changesBetween,
  dayValue,
  describeChange,
  renderValue,
  takaValue,
} from './activity.diff'
import type { FieldSpec } from './activity.diff'

/**
 * The journal's decisions, tested without a database.
 *
 * Two kinds of test here, and the second kind matters more. The first asks
 * whether a change is spotted. The second asks whether the vocabulary is
 * *whole* — whether every action a service can write has a module, a category
 * and a severity, and whether the three derived filters partition the same set
 * the list queries. Nothing about that would show up in a controller test: a
 * missing entry in `ACTION_META` degrades quietly to a neutral reading, which
 * is the right behaviour for a row written in 2025 and the wrong one for an
 * action added this afternoon.
 */

describe('the action vocabulary', () => {
  it('gives every action a meaning', () => {
    for (const action of ACTIVITY_ACTIONS) {
      const meta = ACTION_META[action]
      assert.ok(meta, `${action} has no entry in ACTION_META`)
      assert.ok(meta.label.length > 0, `${action} has no label`)
    }
  })

  it('has no action in ACTION_META that no module declares', () => {
    const declared = new Set<string>(ACTIVITY_ACTIONS)
    for (const action of Object.keys(ACTION_META)) {
      assert.ok(declared.has(action), `${action} is described but never grouped`)
    }
  })

  it('files every action under the module that declares it', () => {
    for (const module of ACTIVITY_MODULES) {
      const declared = ACTION_GROUPS[module] as readonly string[]
      for (const action of declared) {
        assert.equal(
          ACTION_META[action as keyof typeof ACTION_META].module,
          module,
          `${action} is grouped under ${module} but described as something else`,
        )
      }
    }
  })

  /**
   * The list's module filter resolves to an `$in` over actions, so a module
   * whose actions do not add up to the whole set would silently answer a
   * narrower question than the one asked.
   */
  it('partitions every action across the modules exactly once', () => {
    const seen = ACTIVITY_MODULES.flatMap((module: ActivityModule) => actionsOfModule(module))
    assert.equal(seen.length, ACTIVITY_ACTIONS.length)
    assert.equal(new Set(seen).size, ACTIVITY_ACTIONS.length)
  })

  it('narrows to the intersection when a module and a category are both asked for', () => {
    const vendorDeletions = actionsOfModule('Vendor').filter((action) =>
      actionsOfCategory('delete').includes(action),
    )

    assert.ok(vendorDeletions.includes('vehicle.deleted'))
    assert.ok(!vendorDeletions.includes('vehicle.created'))
    assert.ok(!vendorDeletions.includes('challan.deleted'))
  })

  it('treats deletions and access changes as the critical ones', () => {
    const critical = actionsOfSeverity('critical')

    assert.ok(critical.includes('user.role'))
    assert.ok(critical.includes('accounts.entry-updated'))
    assert.ok(critical.includes('product-rate.updated'))
    assert.ok(critical.includes('challan.deleted'))

    // A busy week is not an emergency: filing records stays ordinary.
    assert.ok(!critical.includes('challan.created'))
    assert.ok(!critical.includes('gate-pass.created'))
  })

  /**
   * A row written under a vocabulary that has since moved on still has to
   * render. The action column is deliberately not a Mongoose enum for this
   * reason, and this is the read-side half of that decision.
   */
  it('degrades an unrecognised action to a neutral reading rather than throwing', () => {
    const meta = actionMeta('something.retired')
    assert.equal(meta.severity, 'info')
    assert.ok(meta.label.length > 0)
  })

  /** The vendor actions are the legacy collection's own strings — see the migration. */
  it('keeps the legacy vendor action spellings', () => {
    for (const action of ['vendor.created', 'vehicle.status', 'assignment.ended', 'trip.deleted']) {
      assert.ok(ACTIVITY_ACTIONS.includes(action as never), `${action} was renamed`)
    }
  })
})

describe('rendering a value for a journal row', () => {
  it('tells an absent value apart from an empty one', () => {
    // A note that was never written, and a note somebody cleared. On screen
    // they look the same; in a journal they are different facts.
    assert.equal(renderValue(null), null)
    assert.equal(renderValue(undefined), null)
    assert.equal(renderValue(''), '')
  })

  it('renders the primitives as a person would read them', () => {
    assert.equal(renderValue(' Mirpur '), 'Mirpur')
    assert.equal(renderValue(1500), '1500')
    assert.equal(renderValue(true), 'Yes')
    assert.equal(renderValue(false), 'No')
  })

  it('drops a value that has no readable form rather than printing object noise', () => {
    assert.equal(renderValue({ deep: { thing: 1 } }), null)
    assert.equal(renderValue(Number.NaN), null)
    assert.equal(renderValue(new Date('nonsense')), null)
  })

  it('joins a list and keeps an empty one distinguishable', () => {
    assert.equal(renderValue(['A', 'B']), 'A, B')
    assert.equal(renderValue([]), '')
  })

  it('keeps money in taka and a day as a day', () => {
    assert.equal(takaValue(0), '৳0')
    assert.equal(takaValue(null), null)
    assert.equal(dayValue(new Date('2026-08-14T18:00:00.000Z')), '2026-08-14')
    assert.equal(dayValue(null), null)
  })
})

interface Subject {
  name: string
  qty: number
  note: string | null
  active: boolean
}

const SPECS: FieldSpec<Subject>[] = [
  { field: 'name', label: 'Customer' },
  { field: 'qty', label: 'Quantity' },
  { field: 'note', label: 'Note' },
  { field: 'active', label: 'In use' },
]

describe('working out what changed', () => {
  it('reports only the fields that moved', () => {
    const changes = changesBetween<Subject>(
      { name: 'Walton', qty: 4, note: null, active: true },
      { name: 'Walton', qty: 3, note: null, active: true },
      SPECS,
    )

    assert.equal(changes.length, 1)
    assert.deepEqual(changes[0], { field: 'qty', label: 'Quantity', from: '4', to: '3' })
  })

  it('counts clearing a value as a change, and records the blank', () => {
    const changes = changesBetween<Subject>(
      { note: 'Left at the gate' },
      { note: null },
      SPECS,
    )

    assert.equal(changes.length, 1)
    assert.equal(changes[0]?.to, null)
    assert.equal(describeChange(changes[0]!), 'Note Left at the gate → blank')
  })

  /**
   * A field nobody named is never inspected, which is what keeps a row about
   * the change somebody made: `updatedAt` moves on every save and says nothing.
   */
  it('ignores a field the caller did not ask about', () => {
    const changes = changesBetween<Subject>(
      { name: 'A', qty: 1 },
      { name: 'A', qty: 1 },
      [{ field: 'name', label: 'Customer' }],
    )

    assert.deepEqual(changes, [])
  })

  it('stops at the cap rather than storing an unbounded diff', () => {
    const many = Array.from({ length: MAX_ACTIVITY_CHANGES + 5 }, (_, index) => ({
      field: `f${index}`,
      label: `Field ${index}`,
    })) as FieldSpec<Record<string, unknown>>[]

    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const spec of many) {
      before[spec.field] = 'old'
      after[spec.field] = 'new'
    }

    assert.equal(changesBetween(before, after, many).length, MAX_ACTIVITY_CHANGES)
  })
})

describe('summarising a set of changes', () => {
  it('reads as a sentence at one, two and three fields', () => {
    const change = (label: string) => ({ field: label, label, from: 'a', to: 'b' })

    assert.equal(changeSummary([change('Customer')]), 'customer')
    assert.equal(changeSummary([change('Customer'), change('Vehicle')]), 'customer and vehicle')
    assert.equal(
      changeSummary([change('Customer'), change('Vehicle'), change('Unit')]),
      'customer, vehicle and unit',
    )
  })

  it('names three and counts the rest', () => {
    const changes = ['A', 'B', 'C', 'D', 'E'].map((label) => ({
      field: label,
      label,
      from: null,
      to: 'x',
    }))

    assert.equal(changeSummary(changes), 'a, b, c and 2 more')
  })

  it('says so when nothing moved', () => {
    assert.equal(changeSummary([]), 'no field changes')
  })
})
