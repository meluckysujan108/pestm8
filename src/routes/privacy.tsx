import { createFileRoute } from '@tanstack/react-router'
import { LegalList, LegalPage, LegalSection } from '#/components/xero/LegalPage'

/**
 * PestM8's privacy policy, public, under the Privacy Act 1988 and its
 * Australian Privacy Principles. Xero's developer terms ask for one; so does
 * the Act, for a business that holds what PestM8 holds.
 *
 * A plain-English DRAFT for the business owner to approve — and to have
 * checked by someone who advises on privacy, given what connecting Xero does
 * (every client copied into each connected organisation, members' own
 * included, kept after they leave). `draft` says so on the page until it is
 * taken off. Bump `XERO_TERMS_VERSION` (convex/lib/xeroConfig.ts), and
 * `changed` with it, with any change to what it says about Xero.
 *
 * Contact is the business that uses PestM8 for the person reading, not an
 * address here: PestM8 holds each business's records for that business, and
 * it is the one that can answer for them.
 */
export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: 'Privacy policy · PestM8' }] }),
  component: PrivacyPage,
})

function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      lede="What PestM8 keeps about people, why, who it goes to, and how it is protected."
      changed="6 October 2026"
      draft
      other={{ href: '/terms', label: 'Terms of use' }}
    >
      <LegalSection title="Who this is about">
        <p>
          PestM8 is software that Australian pest control businesses use to run
          their work. It holds information about the people in each business —
          its owner and team — and about the business’s clients. Each business
          decides what goes into PestM8, and PestM8 holds it for that business.
        </p>
      </LegalSection>

      <LegalSection title="What PestM8 keeps">
        <LegalList
          items={[
            'About the team: names, email addresses, phone numbers, licence numbers and licence documents, signatures, and a record of what each person did in PestM8.',
            'About clients: names, phone numbers, email addresses, postal and street addresses, ABNs, site contacts and notes, and the jobs, reports and photos of the work done for them.',
          ]}
        />
      </LegalSection>

      <LegalSection title="Why">
        <p>
          To run PestM8 for the business: to book and schedule its jobs, to
          prepare and email its reports, to keep its records as the law asks of
          a pest control business, and to keep PestM8 secure. PestM8 doesn’t
          sell information, and doesn’t use it for advertising.
        </p>
      </LegalSection>

      <LegalSection title="Xero">
        <p>
          When a business’s owner connects the business’s Xero, or a contractor
          or subcontractor connects their own Xero organisation, PestM8 copies
          the business’s client list into each connected organisation — names,
          phone numbers, email addresses, addresses and ABNs — and keeps it up
          to date. Leads are copied once their first job is booked.
        </p>
        <LegalList
          items={[
            'Every connected organisation receives every client, including a team member’s own organisation.',
            'Clients copied into a team member’s own Xero stay in that organisation after the member leaves the business. PestM8 disconnects their Xero when they are removed, but cannot remove what was already copied.',
            'PestM8 never deletes anything in Xero.',
            'What PestM8 reads from Xero is used only to keep those contacts in step. It is never used to train artificial intelligence, and never shared with anyone except as the person who connected Xero has asked.',
            'Only someone signed in with two-step sign-in can connect Xero.',
            'The keys that let PestM8 reach Xero are encrypted, and are kept apart from what unlocks them. Disconnecting removes PestM8’s access to that organisation.',
          ]}
        />
      </LegalSection>

      <LegalSection title="Who else handles it">
        <p>
          PestM8 uses service providers to run: its database and hosting, the
          service that sends its emails, and Xero where a business connects it.
          Some of them keep information outside Australia, including in the
          United States. They handle it only to provide their service to PestM8.
        </p>
      </LegalSection>

      <LegalSection title="Keeping it safe">
        <p>
          Information is sent over encrypted connections, each person sees only
          what their role in the business allows, and signing in can need a
          second step. Deleted records wait in a recycle bin for 30 days before
          they are removed for good.
        </p>
      </LegalSection>

      <LegalSection title="Seeing or correcting it">
        <p>
          A client can ask the business that services them to see or correct
          what it holds about them, and the business can do that in PestM8.
          Anyone on a business’s team can see and change their own details in
          Settings.
        </p>
      </LegalSection>

      <LegalSection title="Questions and complaints">
        <p>
          Questions about how a business handles your information go to the
          owner of that business. If you aren’t satisfied with the answer, you
          can complain to the Office of the Australian Information Commissioner
          (oaic.gov.au).
        </p>
      </LegalSection>
    </LegalPage>
  )
}
