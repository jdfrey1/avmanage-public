export type Direction = 'debit' | 'credit'
export type MemberRole = 'owner' | 'lessee'

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December']
const now = new Date()
const MONTH_YEAR = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`

export interface LedgerType {
  direction: Direction
  label: string
  defaultDesc: string
  // Roles that can use this type; omitted = everyone.
  roles?: MemberRole[]
}

export const TYPE_CONFIG: Record<string, LedgerType> = {
  monthly_lease:     { direction: 'debit',  label: 'Monthly lease',     defaultDesc: `Monthly lease – ${MONTH_YEAR}`, roles: ['lessee'] },
  one_time_fuel:     { direction: 'debit',  label: 'Fuel',              defaultDesc: 'Fuel' },
  tks:               { direction: 'debit',  label: 'TKS',               defaultDesc: 'TKS fluid' },
  oil:               { direction: 'debit',  label: 'Oil',               defaultDesc: 'Oil' },
  annual:            { direction: 'debit',  label: 'Annual',            defaultDesc: 'Annual inspection', roles: ['owner'] },
  maintenance:       { direction: 'debit',  label: 'Maintenance',       defaultDesc: 'Maintenance', roles: ['owner'] },
  subscriptions:     { direction: 'debit',  label: 'Subscriptions',     defaultDesc: 'Subscription', roles: ['owner'] },
  insurance:         { direction: 'debit',  label: 'Insurance',         defaultDesc: 'Insurance', roles: ['owner'] },
  hangar:            { direction: 'debit',  label: 'Hangar',            defaultDesc: 'Hangar' },
  capital:           { direction: 'debit',  label: 'Capital',           defaultDesc: 'Capital improvement', roles: ['owner'] },
  manual_adjustment: { direction: 'debit',  label: 'Manual adjustment', defaultDesc: 'Manual adjustment' },
}

// Types offered when entries apply to people with the given roles (only types valid for all of them).
export function typesFor(roles: (MemberRole | undefined)[]): [string, LedgerType][] {
  const rs = roles.length ? roles : ['lessee' as MemberRole]
  return Object.entries(TYPE_CONFIG).filter(([, t]) => !t.roles || rs.every(r => r && t.roles!.includes(r)))
}
