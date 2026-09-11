import { AU_STATES } from '#/lib/au'
import { Segmented } from '#/components/primitives/Segmented'

export type ClientKind = 'person' | 'business'

export type NewClientFieldsValue = {
  kind: ClientKind
  clientName: string
  addressLine: string
  suburb: string
  state: string
  postcode: string
  phone: string
  email: string
}

export const EMPTY_NEW_CLIENT: NewClientFieldsValue = {
  kind: 'person',
  clientName: '',
  addressLine: '',
  suburb: '',
  state: 'WA',
  postcode: '',
  phone: '',
  email: '',
}

/**
 * The client + first-property fields, shared between `NewPropertySheet.tsx`
 * (adding a client on its own) and `NewJobSheet.tsx` (adding one inline
 * while booking a job) — extracted so the two stay identical rather than
 * drifting if either is tweaked later.
 */
export function NewClientFields({
  value,
  onChange,
}: {
  value: NewClientFieldsValue
  onChange: (patch: Partial<NewClientFieldsValue>) => void
}) {
  return (
    <>
      <Field label="Client type">
        <Segmented
          label="Client type"
          value={value.kind}
          onChange={(kind) => onChange({ kind })}
          options={[
            { value: 'person', label: 'Person' },
            { value: 'business', label: 'Business' },
          ]}
        />
      </Field>

      <Field
        label={value.kind === 'business' ? 'Business name' : 'Client name'}
      >
        <Input
          value={value.clientName}
          onChange={(clientName) => onChange({ clientName })}
          required
        />
      </Field>
      <Field label="Street address">
        <Input
          value={value.addressLine}
          onChange={(addressLine) => onChange({ addressLine })}
          required
        />
      </Field>
      <Field label="Suburb">
        <Input
          value={value.suburb}
          onChange={(suburb) => onChange({ suburb })}
          required
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="State">
          <select
            value={value.state}
            onChange={(e) => onChange({ state: e.target.value })}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          >
            {AU_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Postcode">
          <Input
            value={value.postcode}
            onChange={(postcode) => onChange({ postcode })}
            required
            inputMode="numeric"
          />
        </Field>
      </div>

      <Field label="Phone (optional)">
        <Input
          value={value.phone}
          onChange={(phone) => onChange({ phone })}
          type="tel"
        />
      </Field>
      <Field label="Email (optional)">
        <Input
          value={value.email}
          onChange={(email) => onChange({ email })}
          type="email"
        />
      </Field>
    </>
  )
}

function Input({
  value,
  onChange,
  type = 'text',
  required,
  inputMode,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  inputMode?: 'numeric' | 'decimal' | 'tel'
}) {
  return (
    <input
      type={type}
      value={value}
      required={required}
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
      className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
    />
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="mt-4 flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  )
}
