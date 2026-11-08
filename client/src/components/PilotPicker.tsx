import { Select } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { PartnershipMember } from '@/lib/api'

const SELECT_CLASS = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring'

// Pilot for a flight: a member, or someone else ("Other") whose flight is charged to a member's
// hours. otherName is null when a member flew; pilotId is always the member charged.
export function PilotPicker({ members, pilotId, setPilotId, otherName, setOtherName }: {
  members: PartnershipMember[]
  pilotId: string
  setPilotId: (id: string) => void
  otherName: string | null
  setOtherName: (name: string | null) => void
}) {
  const isOther = otherName !== null
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Pilot</Label>
        <Select
          value={isOther ? 'other' : pilotId}
          onChange={e => {
            if (e.target.value === 'other') setOtherName('')
            else { setOtherName(null); setPilotId(e.target.value) }
          }}
          className={SELECT_CLASS}
        >
          {members.map(m => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
          <option value="other">Other…</option>
        </Select>
      </div>
      {isOther && (
        <>
          <div className="space-y-1.5">
            <Label>Pilot name</Label>
            <Input value={otherName} onChange={e => setOtherName(e.target.value)} placeholder="Who flew" required />
          </div>
          <div className="space-y-1.5">
            <Label>Hours charged to</Label>
            <Select value={pilotId} onChange={e => setPilotId(e.target.value)} className={SELECT_CLASS}>
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </div>
        </>
      )}
    </div>
  )
}
