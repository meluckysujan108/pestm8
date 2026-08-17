import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import { X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { AU_STATES } from '#/lib/au'
import type { Id } from '../../../convex/_generated/dataModel'

export function NewPropertySheet({
  businessId,
  open,
  onClose,
}: {
  businessId: Id<'businesses'>
  open: boolean
  onClose: () => void
}) {
  const [clientName, setClientName] = useState('')
  const [addressLine, setAddressLine] = useState('')
  const [suburb, setSuburb] = useState('')
  const [state, setState] = useState('WA')
  const [postcode, setPostcode] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')

  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  const convexCreate = useConvexMutation(api.properties.create)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      clientName: string
      addressLine: string
      suburb: string
      state: string
      postcode: string
      phone?: string
      email?: string
    }) => convexCreate(args),
    onSuccess: () => {
      setClientName('')
      setAddressLine('')
      setSuburb('')
      setPostcode('')
      setPhone('')
      setEmail('')
      onClose()
    },
  })

  return (
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />

          <form
            className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
            onSubmit={(e) => {
              e.preventDefault()
              create.mutate({
                businessId,
                clientName,
                addressLine,
                suburb,
                state,
                postcode,
                phone: phone.trim() || undefined,
                email: email.trim() || undefined,
              })
            }}
          >
            <Drawer.Title className="text-sheet-title text-ink">
              New property
            </Drawer.Title>

            <Field label="Client name">
              <Input value={clientName} onChange={setClientName} required />
            </Field>
            <Field label="Street address">
              <Input value={addressLine} onChange={setAddressLine} required />
            </Field>
            <Field label="Suburb">
              <Input value={suburb} onChange={setSuburb} required />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="State">
                <select
                  value={state}
                  onChange={(e) => setState(e.target.value)}
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
                  value={postcode}
                  onChange={setPostcode}
                  required
                  inputMode="numeric"
                />
              </Field>
            </div>

            <Field label="Phone (optional)">
              <Input value={phone} onChange={setPhone} type="tel" />
            </Field>
            <Field label="Email (optional)">
              <Input value={email} onChange={setEmail} type="email" />
            </Field>

            {create.isError && (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
              >
                Could not save this property.
              </p>
            )}

            <button
              type="submit"
              disabled={create.isPending || !hydrated}
              className="mt-5 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
            >
              {create.isPending ? 'Saving…' : 'Save property'}
            </button>
          </form>

          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
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
