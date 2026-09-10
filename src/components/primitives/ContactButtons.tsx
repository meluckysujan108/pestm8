import { Mail, MessageSquareText, Phone } from 'lucide-react'
import { HoldButton } from './HoldButton'

/**
 * Hold-to-call/text/email row, shared by ClientSheet.tsx (a client's own
 * line, and once per named contact) and JobDetailSheet.tsx (a job's client)
 * so the three stay pixel-identical rather than drifting. Renders nothing if
 * neither `phone` nor `email` is set; Text is offered wherever Call is,
 * since both dial the same number.
 */
export function ContactButtons({
  name,
  phone,
  email,
}: {
  name: string
  phone?: string
  email?: string
}) {
  if (!phone && !email) return null

  return (
    <div className="flex gap-2">
      {phone && (
        <HoldButton
          ariaLabel={`Call ${name}`}
          onComplete={() => {
            window.location.href = `tel:${phone}`
          }}
          className="flex flex-1 flex-col items-center justify-center gap-1 rounded-xl bg-surface-2 py-2.5 text-caption font-semibold text-blue"
        >
          <Phone size={17} strokeWidth={1.7} />
          Call
        </HoldButton>
      )}
      {phone && (
        <HoldButton
          ariaLabel={`Text ${name}`}
          onComplete={() => {
            window.location.href = `sms:${phone}`
          }}
          className="flex flex-1 flex-col items-center justify-center gap-1 rounded-xl bg-surface-2 py-2.5 text-caption font-semibold text-blue"
        >
          <MessageSquareText size={17} strokeWidth={1.7} />
          Text
        </HoldButton>
      )}
      {email && (
        <HoldButton
          ariaLabel={`Email ${name}`}
          onComplete={() => {
            window.location.href = `mailto:${email}`
          }}
          className="flex flex-1 flex-col items-center justify-center gap-1 rounded-xl bg-surface-2 py-2.5 text-caption font-semibold text-blue"
        >
          <Mail size={17} strokeWidth={1.7} />
          Email
        </HoldButton>
      )}
    </div>
  )
}
