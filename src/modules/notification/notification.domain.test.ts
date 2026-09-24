import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isMuted, selectRecipients } from './notification.audience'
import {
  MAX_NOTIFICATION_FANOUT,
  MUTABLE_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_GROUPS,
  NOTIFICATION_EVENT_META,
  eventsOfCategory,
  eventsOfModule,
  eventsOfPriority,
  notificationEventMeta,
} from './notification.constants'
import type { NotificationCategory } from './notification.constants'

/**
 * The notification system's decisions.
 *
 * Only what is genuinely a decision is here, which is the rule CLAUDE.md sets
 * for this codebase's tests. Three things qualify:
 *
 * - **Who gets told**, because the fan-out is the module's one piece of
 *   arithmetic and the two rules in it — never the actor, never twice — are
 *   exactly the kind that a refactor quietly loses.
 * - **What may be muted**, because "you cannot switch off being told your
 *   account was suspended" is a business rule rather than a form's behaviour,
 *   and a rule enforced only by a Zod enum is a rule one new endpoint away from
 *   being gone.
 * - **The vocabulary's integrity**, because module, category and priority are
 *   *derived* from the event at serialisation. A missing entry there is an event
 *   that silently files itself under the wrong heading and matches no filter —
 *   which is the one failure a message list cannot afford.
 */

describe('who gets told', () => {
  it('never tells somebody what they have just done themselves', () => {
    // The whole point: a system that announces your own work to you has a badge
    // that is always lit, and a badge that is always lit is never read.
    assert.deepEqual(selectRecipients(['a', 'b', 'c'], 'b'), ['a', 'c'])
  })

  it('tells nobody when the actor is the only person in the audience', () => {
    // An ordinary morning in a one-person office: the operator who files a gate
    // pass is also the only reviewer. Nothing should be written at all.
    assert.deepEqual(selectRecipients(['a'], 'a'), [])
  })

  it('collapses duplicates, because two paths to one person is still one person', () => {
    assert.deepEqual(selectRecipients(['a', 'b', 'a'], null), ['a', 'b'])
  })

  it('drops empty ids rather than addressing a message at nothing', () => {
    assert.deepEqual(selectRecipients(['', 'a', ''], null), ['a'])
  })

  it('keeps the audience it was given when nobody is excluded', () => {
    assert.deepEqual(selectRecipients(['a', 'b'], null), ['a', 'b'])
  })

  it('stops at the fan-out ceiling rather than writing without bound', () => {
    const many = Array.from({ length: MAX_NOTIFICATION_FANOUT + 25 }, (_, index) => `u${index}`)
    assert.equal(selectRecipients(many, null).length, MAX_NOTIFICATION_FANOUT)
  })
})

describe('what somebody may switch off', () => {
  it('honours a muted category', () => {
    assert.equal(isMuted('compliance', ['compliance', 'money']), true)
  })

  it('leaves a category alone when it is not muted', () => {
    assert.equal(isMuted('compliance', ['money']), false)
  })

  /**
   * The rule, not the form's behaviour. An account that silently stops working
   * is a support call; one whose owner was told is a Tuesday — so `account` is
   * outside `MUTABLE_CATEGORIES` and a stored value saying otherwise is ignored
   * rather than obeyed.
   */
  it('refuses to mute the account category even when the stored list says so', () => {
    assert.equal(isMuted('account', ['account']), false)
  })

  it('offers every category but the account one as mutable', () => {
    assert.deepEqual(
      [...MUTABLE_CATEGORIES],
      NOTIFICATION_CATEGORIES.filter((category) => category !== 'account'),
    )
  })
})

describe('the event vocabulary', () => {
  it('describes every event it declares', () => {
    // A missing entry files an event under a neutral default: wrong module,
    // wrong colour, and matched by no filter anybody would think to try.
    for (const event of NOTIFICATION_EVENTS) {
      assert.ok(NOTIFICATION_EVENT_META[event], `${event} has no meta`)
    }
  })

  it('describes nothing it does not declare', () => {
    const declared = new Set<string>(NOTIFICATION_EVENTS)
    for (const event of Object.keys(NOTIFICATION_EVENT_META)) {
      assert.ok(declared.has(event), `${event} is described but not declared`)
    }
  })

  it('files each event under the module that declares it', () => {
    // The flat list is built from the groups, so this pins the *other*
    // direction: an event moved between groups without its meta being changed.
    for (const [module, events] of Object.entries(NOTIFICATION_EVENT_GROUPS)) {
      for (const event of events) {
        assert.equal(
          NOTIFICATION_EVENT_META[event].module,
          module,
          `${event} is grouped under ${module} and described as ${NOTIFICATION_EVENT_META[event].module}`,
        )
      }
    }
  })

  it('degrades an unknown event rather than throwing on it', () => {
    // The event is a plain string on the document precisely so a retired one
    // never makes an unread row unreadable. That only holds if reading it back
    // is safe.
    const meta = notificationEventMeta('something.retired')
    assert.equal(meta.label, 'Notification')
    assert.equal(meta.priority, 'info')
  })

  it('resolves a module filter to that module s events and no others', () => {
    const events = eventsOfModule('Vendor')
    assert.deepEqual(events, ['vendor.document-expiring', 'vendor.document-expired'])
  })

  it('resolves a category filter across modules', () => {
    // "Show me everything about compliance" crosses Delivery and Vendor, which
    // is the question a category filter exists to answer.
    const events = eventsOfCategory('compliance')
    assert.ok(events.includes('delivery.copy-missing'))
    assert.ok(events.includes('vendor.document-expired'))
  })

  it('keeps urgent for what is already wrong rather than for what is merely busy', () => {
    const urgent = eventsOfPriority('urgent')
    assert.deepEqual(urgent, ['account.suspended', 'vendor.document-expired'])
  })

  it('leaves no category without at least one event to put in it', () => {
    // A category nothing can produce is a filter chip that always reads zero,
    // and a preferences switch that turns nothing off.
    for (const category of NOTIFICATION_CATEGORIES) {
      assert.ok(
        eventsOfCategory(category as NotificationCategory).length > 0,
        `${category} has no events`,
      )
    }
  })
})
