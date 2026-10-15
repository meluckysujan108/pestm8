import { createFileRoute } from '@tanstack/react-router'
import { LegalList, LegalPage, LegalSection } from '#/components/xero/LegalPage'

/**
 * PestM8's terms of use, public: Xero's developer terms ask an app that
 * connects to it to have its own, and to record that each person agreed to
 * them (the connect's audit row carries `termsVersion`, from
 * `XERO_TERMS_VERSION` in convex/lib/xeroConfig.ts — bump it with any change
 * here to what connecting Xero means).
 *
 * A plain-English DRAFT for the business owner to approve, and to have
 * checked, before it is put in front of anyone: `draft` says so on the page
 * until it is taken off. `changed` moves with `XERO_TERMS_VERSION`.
 */
export const Route = createFileRoute('/terms')({
  head: () => ({ meta: [{ title: 'Terms of use · PestM8' }] }),
  component: TermsPage,
})

function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      lede="What you agree to by using PestM8, and by connecting it to Xero."
      changed="6 October 2026"
      draft
      other={{ href: '/privacy', label: 'Privacy policy' }}
    >
      <LegalSection title="About PestM8">
        <p>
          PestM8 is scheduling and compliance-reporting software for Australian
          pest control businesses. A business uses it to book jobs, keep its
          client list and write its reports. These terms apply to everyone who
          signs in to PestM8: a business’s owner and the contractors and
          subcontractors on its team.
        </p>
      </LegalSection>

      <LegalSection title="Your account">
        <LegalList
          items={[
            'Keep your password to yourself, and turn on two-step sign-in where you can.',
            'You may only sign in to a business you have been invited into. The business’s owner decides who is on its team, and can remove anyone.',
            'What you do in PestM8 is recorded against your name, including work you do while switched into someone else’s account.',
          ]}
        />
      </LegalSection>

      <LegalSection title="The business’s information">
        <p>
          A business’s clients, jobs, reports and photos are the business’s.
          PestM8 keeps them for the business and uses them only to run PestM8
          for it. The owner of each business is responsible for having its
          clients’ permission to keep their details and to send them reports.
        </p>
      </LegalSection>

      <LegalSection title="Connecting Xero">
        <p>
          Connecting Xero is optional, and only the person connecting can do it,
          through Xero’s own sign-in. By connecting, you agree that:
        </p>
        <LegalList
          items={[
            'PestM8 copies the business’s client list — names, phone numbers, email addresses, postal and street addresses, and ABNs — into the Xero organisation you connect, and keeps it up to date as clients change. Leads are copied once their first job is booked.',
            'This applies to every Xero organisation connected in the business: the one the owner connects for the business, and any a contractor or subcontractor connects as their own. Each receives every client, not only the clients they work for.',
            'Contacts copied into a team member’s own Xero stay there after they leave the business. PestM8 disconnects their Xero when they are removed from the team, but it cannot take back what is already in their organisation.',
            'PestM8 never deletes or archives anything in Xero. Contacts it has added stay in Xero if you disconnect.',
            'The owner of the business can see which Xero organisation each team member has connected.',
          ]}
        />
        <p>
          You can disconnect at any time, in Settings → Xero or Settings → My
          Xero, or in Xero under Settings → Connected apps. Xero’s own terms
          apply to your Xero organisation. PestM8 is not made or endorsed by
          Xero.
        </p>
      </LegalSection>

      <LegalSection title="Using PestM8 fairly">
        <LegalList
          items={[
            'Use PestM8 for your pest control work, and keep in it only information you are allowed to keep.',
            'Don’t try to reach another business’s information, or to get around what your role allows.',
            'Don’t use PestM8 to send anyone email they haven’t asked for.',
          ]}
        />
      </LegalSection>

      <LegalSection title="If something goes wrong">
        <p>
          PestM8 is looked after carefully, but it can be unavailable at times,
          and it may change as it improves. Check what PestM8 prepares before
          you rely on it — a report you sign is yours. Nothing in these terms
          takes away your rights under the Australian Consumer Law.
        </p>
      </LegalSection>

      <LegalSection title="Changes to these terms">
        <p>
          When these terms change, the date at the top changes with them, and
          connecting Xero after that means agreeing to the new version.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
