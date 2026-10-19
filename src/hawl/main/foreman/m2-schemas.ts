// Local schemas for the two m2 shapes that are not in the vendored gateway-contract:
// the extended menu (m2-contract.md section 3.1, "Menu = gateway menu plus optional additions")
// and the hand-back body (section 3.4, POST /v1/handoffs/:id/foreman {op, reason?}).
// They are built from the vendored menu schema, so the strict base cannot drift from the extension.
// NOT proven against a relay: the relay-side schema edit (task F0) and route are other pieces.
import { checkSchema, type Schema } from '../../shared/gateway-contract/schema-check'
import menuSchema from '../../shared/gateway-contract/schemas/menu.schema.json'

type Extendable = {
  properties: Record<string, unknown>
  definitions: { capability: { properties: Record<string, unknown> } }
}

function extend(): Schema {
  const s = structuredClone(menuSchema) as unknown as Extendable
  const slug = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' }
  Object.assign(s.definitions.capability.properties, {
    // m2-contract.md 3.1 capability additions.
    keywords: {
      type: 'array',
      maxItems: 32,
      items: { type: 'string', minLength: 1, maxLength: 64 }
    },
    stations: {
      type: 'array',
      maxItems: 32,
      items: { type: 'string', pattern: '^vil_[A-Za-z0-9_-]+$' }
    },
    approval: { type: 'string', enum: ['auto', 'ask_owner'] },
    accept_from: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 64 }
    },
    accept_when_offline: { type: 'boolean' },
    next: { type: 'array', maxItems: 16, items: slug },
    // Not in the m2 field list, but S11 needs the ledger to show closed capabilities. A gap to settle in F0.
    open: { type: 'boolean' }
  })
  // m2-contract.md 3.1 top-level additions.
  Object.assign(s.properties, {
    hold_minutes: { type: 'integer', minimum: 1, maximum: 10080 },
    release_minutes: { type: 'integer', minimum: 1, maximum: 43200 },
    direct_lines: { type: 'string', enum: ['job_parties', 'ask_owner', 'never'] }
  })
  return s as unknown as Schema
}

export const EXTENDED_MENU_SCHEMA: Schema = extend()

export const HAND_BACK_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['op'],
  properties: {
    op: { type: 'string', enum: ['decline', 'release'] },
    reason: { type: 'string', minLength: 1, maxLength: 500 }
  }
}

/** One-line error, or null when the value fits. */
export function checkExtendedMenu(value: unknown): string | null {
  const errs = checkSchema(EXTENDED_MENU_SCHEMA, value)
  return errs.length === 0 ? null : errs.join('; ')
}

export function checkHandBack(op: string, reason: string): string | null {
  const errs = checkSchema(HAND_BACK_SCHEMA, { op, ...(reason ? { reason } : {}) })
  return errs.length === 0 ? null : errs.join('; ')
}
