/**
 * The Terms and Conditions of the Existing Structure Certificate of
 * Installation (AS 3660.2-2017), word for word.
 *
 * Source: docs/sources/termite-certificate.md, §9 "TERMS AND CONDITIONS OF
 * CERTIFICATE" (lines 146-213). The Certificate is the only source for this
 * text (fidelity.md precedence rule 5). No correction in fidelity.md touches
 * it, so nothing here is edited: trailing whitespace at the end of four
 * source lines (154, 158, 167, 200) is not wording and is not reproduced.
 *
 * The section heading itself ("9. TERMS AND CONDITIONS OF CERTIFICATE") is not
 * part of this document — it prints from `print.termsHeading` on the template.
 *
 * Shared: the Timber Pest Inspection template prints this as an INTERIM, until
 * the owner exports the Timber form's own terms from Formitize form 24915944
 * (fidelity.md "Open with the owner").
 *
 * Kept verbatim, flagged for the owner (fidelity.md "Kept verbatim, flagged"):
 * - the definitions say "This Plan" — the text was adapted from a Termite
 *   Management Plan;
 * - three definitions cross-reference sections the Certificate does not
 *   contain: "Inspection Report", "Inspection Agreement", "Property Address";
 * - "Purpose Of Termite Management Systems" (capital "Of");
 * - "Constructions issues and faults:";
 * - "species in Australian including".
 */
import type { RichDoc } from '../types'

export const CERTIFICATE_TERMS: RichDoc = {
  type: 'doc',
  content: [
    // src: termite-certificate.md:148
    // FLAG: "Purpose Of Termite Management Systems" — capital "Of".
    {
      type: 'heading',
      level: 2,
      content: [{ type: 'text', text: 'Purpose Of Termite Management Systems' }],
    },
    // src: termite-certificate.md:149
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'The purpose of termite management systems is to deter unobservable termite entry. It is expected that the risk of future undetected termite activity leading to incidents of significant structural damage to the Property will be significantly reduced with a correctly installed termite management system.',
        },
      ],
    },
    // src: termite-certificate.md:151
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Different termite management systems are appropriate for different environments and forms of construction. More than one type of system may be incorporated as required.',
        },
      ],
    },

    // src: termite-certificate.md:153
    {
      type: 'heading',
      level: 2,
      content: [{ type: 'text', text: 'Limitations' }],
    },
    // src: termite-certificate.md:154
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'This Certificate has been prepared for the use of the named Client only.',
        },
      ],
    },
    // src: termite-certificate.md:156
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Neither the Installer nor the Installation company, are liable for any reliance placed on this Certificate by any third party other than the disclosed Building Owner that instructed the Client.',
        },
      ],
    },
    // src: termite-certificate.md:158
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'This Certificate is in relation to the installation of a termite management system. The Certificate is not a Building Report, Termite Inspection Report or Termite Management Plan.',
        },
      ],
    },
    // src: termite-certificate.md:160
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'This Certificate is in no way a warranty of any kind as to the absence of termites, termite activity or damage. Please be clear that a termite management system is not a guarantee nor is it implied in any way that it will definitely prevent termite attack. The design, materials and situation of the property may prevent complete protection from termite attack.',
        },
      ],
    },
    // src: termite-certificate.md:162
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Unless specifically mentioned, this Certificate does not cover sheet material or concrete slab management systems. Where either of these are used as part of the termite management system, it is the responsibility of the Client to ensure compliance with standards.',
        },
      ],
    },
    // src: termite-certificate.md:164
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'The Client is responsible for the integrity of the termite management system ensuring the system is not bridged during the ongoing construction, plumbing and landscaping processes.',
        },
      ],
    },

    // src: termite-certificate.md:166
    {
      type: 'heading',
      level: 2,
      content: [{ type: 'text', text: 'Exclusions' }],
    },
    // src: termite-certificate.md:167
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'This Certificate is in relation solely to the installation of a termite management system.',
        },
      ],
    },
    // src: termite-certificate.md:169
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'The Certificate specifically excludes the inspection for, and treatment of, termite activity. The Certificate also expressly excludes the rectification or repair of any termite damage from past, current or future termite activity.',
        },
      ],
    },

    // src: termite-certificate.md:171
    {
      type: 'heading',
      level: 2,
      content: [{ type: 'text', text: 'Definitions' }],
    },
    // src: termite-certificate.md:172-197 (26 definitions)
    {
      type: 'definitionList',
      content: [
        // src: termite-certificate.md:172
        // FLAG: "This Plan" — the Certificate is not a Plan; text adapted from a Termite Management Plan.
        {
          type: 'definitionItem',
          term: 'AEPMA',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'AEPMA is the Australian Environmental Pest Managers Association and is the national peak body for professional pest managers in Australia. This Plan and terminology therein have been developed using content and guidance from the AEPMA Code of Practice.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:173
        {
          type: 'definitionItem',
          term: 'Bridging',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Bridging occurs when termites gain access to a building by overcoming a termite management system or inspection zone.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:174
        {
          type: 'definitionItem',
          term: 'Breaching',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Breaching occurs when treated zones are disturbed or broken allowing free passage for termite entry.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:175
        {
          type: 'definitionItem',
          term: 'Builders & Building Contractors',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'People or entities that are contracted to build, or oversee and take responsibility for, the construction of buildings.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:176
        {
          type: 'definitionItem',
          term: 'Building Owners & Managers',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'People or entities that either own the property or have primary responsibility on behalf of the owners for the property.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:177
        {
          type: 'definitionItem',
          term: 'Cellulose',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'A structural organic compound on which termites feed, normally found in plant-based products in the form of timber, paper and cardboard.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:178
        {
          type: 'definitionItem',
          term: 'Client(s)',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'A client is a person for whom or an entity for which, the termite management services are undertaken. Clients may either own the property or manage them on behalf of owners.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:179
        {
          type: 'definitionItem',
          term: 'Concealed Access',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'The situation where termites gain access to a building without such access being easily seen.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:180
        {
          type: 'definitionItem',
          term: 'Conducive Conditions',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Specific environmental conditions known to be favoured and attractive to termites and encouraging of their foraging behaviour.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:181
        // FLAG: dangling cross-reference — the Certificate has no section "Inspection Report".
        {
          type: 'definitionItem',
          term: 'Inspection Report',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Means the Inspection Report prepared and referenced in the section "Inspection Report".',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:182
        // FLAG: dangling cross-reference — the Certificate has no Inspection Agreement.
        {
          type: 'definitionItem',
          term: 'Inspection Agreement',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Means the Agreement in relation to the Inspection Report.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:183
        {
          type: 'definitionItem',
          term: 'Inspection Zone',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'A band of normally no less than 25 mm and typically 75 mm high or wide that is constructed or applied around a building perimeter or subfloor member over which termites overcome in order to reach susceptible materials.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:184
        {
          type: 'definitionItem',
          term: 'Installer',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'The person or persons undertaking the installation.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:185
        {
          type: 'definitionItem',
          term: 'Installation',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'The process of laying out, fitting, checking and if required, testing the termite management systems.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:186
        {
          type: 'definitionItem',
          term: 'Limitations',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'The successful implementation of termite management systems can be affected, compromised or destroyed by events or actions before, during or after their installation.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:187
        {
          type: 'definitionItem',
          term: 'Pest Manager',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'A person licenced to undertake pest management services under relevant legislation and qualified to undertake relevant termite treatments.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:188
        {
          type: 'definitionItem',
          term: 'Pesticide',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Chemical or biological substance used directly or indirectly for controlling, preventing, destroying, repelling or inhibiting pests.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:189
        {
          type: 'definitionItem',
          term: 'Product Label',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Product specific document attached to relevant product containers defining how a product should be safely handled and used.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:190
        // FLAG: dangling cross-reference — the Certificate has no section "Property Address".
        {
          type: 'definitionItem',
          term: 'Property',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Means the buildings and structures at the address noted in the section "Property Address".',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:191
        // FLAG: "species in Australian including" — "in Australia, including".
        {
          type: 'definitionItem',
          term: 'Subterranean Termites',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Termites which normally attack structures from the ground. Termites of the economically important wood-feeding species in Australian including Mastotermitidae, Rhinotermitidae and Termitidae.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:192
        {
          type: 'definitionItem',
          term: 'Termite Damage',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Degradation of materials that can be associated directly to termite attack.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:193
        {
          type: 'definitionItem',
          term: 'Termite Management System',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'A system of treatment that prevents, deters, monitors or detects, controls and/or eliminates termites gaining entry into a building.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:194
        // FLAG: "This Plan" — the Certificate is not a Plan; text adapted from a Termite Management Plan.
        {
          type: 'definitionItem',
          term: 'Termites',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Insects that live in colonies and primarily feed on cellulose. For the purpose of this Plan, termite refers specifically to subterranean termites.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:195
        {
          type: 'definitionItem',
          term: 'Termiticide',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'A pesticide or pesticide-treated article, element or substance used in termite management systems to control and destroy termites.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:196
        {
          type: 'definitionItem',
          term: 'Timber Pest',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Economically significant termites, borers, decay-causing fungi and some airborne pollutants which can attack and degrade seasoned timber.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:197
        {
          type: 'definitionItem',
          term: 'Timber Pest Inspector',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'An appropriately qualified person who undertakes specialist timber pest inspections.',
                },
              ],
            },
          ],
        },
      ],
    },

    // src: termite-certificate.md:199
    {
      type: 'heading',
      level: 2,
      content: [{ type: 'text', text: 'Cultural Management' }],
    },
    // src: termite-certificate.md:200
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'There are many factors that can potentially limit the ability of the termite management system to achieve the desired results and ideal outcome.',
        },
      ],
    },
    // src: termite-certificate.md:202
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'As with all termite management systems, no system is failsafe. The systems can never be guaranteed to prevent concealed termite access to buildings and structures. The following provides some examples of areas the Building Owner can have an impact on reducing the likelihood of termite attack.',
        },
      ],
    },
    // src: termite-certificate.md:204-211 (8 bold-lead bullets; the colon is inside the bold in the source)
    {
      type: 'bulletList',
      content: [
        // src: termite-certificate.md:204
        // FLAG: "Constructions issues and faults:" — "Construction issues and faults".
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Constructions issues and faults:',
                  marks: ['bold'],
                },
                {
                  type: 'text',
                  text: ' The actual construction of the building, particularly around the subfloor and slab construction can impact the limitations of treatment effectiveness. Processes are related to different options including suspended floors, slab-on-ground, monolithic and infill slabs. Each construction type has the potential to limit the effectiveness of the management system.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:205
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Site conditions, especially the soil condition:',
                  marks: ['bold'],
                },
                {
                  type: 'text',
                  text: ' The quality and type of soil can have a major impact on successful system outcomes. Some soils are unsuitable for effective soil termiticide treatment in which case certain soil areas may need replacing with more suitable materials. Heavy clay, for example, makes it very difficult for certain chemicals to evenly distribute throughout the treatment zone. Other potential soil issues include very sandy soils, and areas with layers of granite, blue metal or rock.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:206
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Landscaping restrictions:',
                  marks: ['bold'],
                },
                {
                  type: 'text',
                  text: ' Gardens and pool sheds, gardens against buildings, concrete paths adjoining buildings, retaining walls, fences and all other related landscaping items can create a breach of the protective termite treated zones.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:207
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Limitations on access to inspect, treat and monitor areas of the property:',
                  marks: ['bold'],
                },
                {
                  type: 'text',
                  text: ' If the property includes areas with no or restricted access, inspecting, treating and monitoring of that area will naturally cause limitations to the effectiveness of the management system.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:208
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Restrictive vegetation close to buildings:',
                  marks: ['bold'],
                },
                {
                  type: 'text',
                  text: ' Protective zones can be breached by raised garden beds, retaining walls, large trees that touch buildings and even shrubs against or around buildings.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:209
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Inadequate ventilation of the buildings sub-floor areas and inadequate drainage:',
                  marks: ['bold'],
                },
                {
                  type: 'text',
                  text: ' Availability of food, moisture and warmth is an attraction for termites, so adequately separating the components is an effective strategy against termite activity. Effective ventilation and drainage are therefore very important to be maintained.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:210
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Disturbance or interference of installed termite management systems:',
                  marks: ['bold'],
                },
                {
                  type: 'text',
                  text: ' The treated zones can be deliberately or inadvertently interfered with and broken which can allow concealed entry for termites. Examples include cabling being installed underground, plumbing, drainage and interference by spreading tree roots.',
                },
              ],
            },
          ],
        },
        // src: termite-certificate.md:211
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Client failure to follow recommendations for ongoing maintenance and inspection:',
                  marks: ['bold'],
                },
                {
                  type: 'text',
                  text: ' It is essential that owners follow all written and verbal recommendations. Failure to act on these recommendations may limit the systems ability to achieve successful treatment outcomes.',
                },
              ],
            },
          ],
        },
      ],
    },
    // src: termite-certificate.md:213
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'The actions of the Building Owner can be instrumental in reducing the suitability of the environment to subterranean termites.',
        },
      ],
    },
  ],
}
