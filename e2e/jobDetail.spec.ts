import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
  signUpActor,
  uniqueEmail,
} from './fixtures'
import type { Id } from '../convex/_generated/dataModel'

/**
 * The richer job detail view's backend: sequential per-business job numbers,
 * notes attached to a job with the author's real name resolved (not just
 * their colour), and job photos — all new surface behind the expanded
 * `JobDetailSheet.tsx`.
 */

test('jobs get a sequential, per-business number starting at 1', async () => {
  const owner = await signUpActor(uniqueEmail('jobnum-owner'), FIXTURE_PASSWORD, 'Terence')
  const { businessId } = await owner.client.mutation(api.businesses.create, {
    name: `Job Numbers Co ${Date.now()}`,
    state: 'WA',
    timezone: 'Australia/Perth',
  })
  const propertyId = await owner.client.mutation(api.properties.create, {
    businessId,
    clientName: 'J. Nguyen',
    addressLine: '12 Wattle Street',
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
  })
  const members = await owner.client.query(api.memberships.listForBusiness, { businessId })
  const ownerMembershipId = members.find((m) => m.role === 'owner')!._id

  async function bookJob() {
    const jobId = await owner.client.mutation(api.jobs.create, {
      businessId,
      propertyId,
      assignedMembershipId: ownerMembershipId,
      jobType: 'General Pest Control',
      price: 20000,
      scheduledAt: Date.now() + 86_400_000,
      durationMinutes: 60,
    })
    return owner.client.query(api.jobs.get, { businessId, jobId })
  }

  const first = await bookJob()
  const second = await bookJob()
  const third = await bookJob()

  expect(first?.jobNumber).toBe(1)
  expect(second?.jobNumber).toBe(2)
  expect(third?.jobNumber).toBe(3)

  // A second, unrelated business starts its own count at 1 — this is a
  // per-business sequence, not a global one.
  const otherOwner = await signUpActor(uniqueEmail('jobnum-other'), FIXTURE_PASSWORD, 'Priya')
  const { businessId: otherBusinessId } = await otherOwner.client.mutation(
    api.businesses.create,
    { name: `Other Co ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
  )
  const otherPropertyId = await otherOwner.client.mutation(api.properties.create, {
    businessId: otherBusinessId,
    clientName: 'A. Wilson',
    addressLine: '21 Guildford Road',
    suburb: 'Maylands',
    state: 'WA',
    postcode: '6051',
  })
  const otherMembers = await otherOwner.client.query(api.memberships.listForBusiness, {
    businessId: otherBusinessId,
  })
  const otherOwnerMembershipId = otherMembers.find((m) => m.role === 'owner')!._id
  const otherJobId = await otherOwner.client.mutation(api.jobs.create, {
    businessId: otherBusinessId,
    propertyId: otherPropertyId,
    assignedMembershipId: otherOwnerMembershipId,
    jobType: 'Ants',
    price: 16000,
    scheduledAt: Date.now() + 86_400_000,
    durationMinutes: 45,
  })
  const otherJob = await otherOwner.client.query(api.jobs.get, {
    businessId: otherBusinessId,
    jobId: otherJobId,
  })
  expect(otherJob?.jobNumber).toBe(1)
})

test('notes on a job resolve the actual author name and role, not just a colour', async () => {
  const s = await setupBusinessWithSub('jobnotes-authors')

  await s.owner.client.mutation(api.notes.create, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    title: 'Owner note on this job',
  })
  await s.owner.client.mutation(api.memberships.setCanViewAllJobs, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    canViewAllJobs: true,
  })
  await s.sub.client.mutation(api.notes.create, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    title: 'Sub note on the same job',
  })

  const notes = await s.owner.client.query(api.notes.listForJob, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })

  expect(notes).toHaveLength(2)
  const ownerNote = notes.find((n) => n.title === 'Owner note on this job')
  const subNote = notes.find((n) => n.title === 'Sub note on the same job')
  expect(ownerNote?.authorName).toBe('Terence')
  expect(ownerNote?.authorRole).toBe('owner')
  expect(subNote?.authorName).toBe('Kevin')
  expect(subNote?.authorRole).toBe('subcontractor')

  // A subcontractor without canViewAllJobs sees only their own note on this
  // job, the same visibility rule every other job-scoped query already has.
  const priya = await signUpActor(uniqueEmail('jobnotes-priya'), FIXTURE_PASSWORD, 'Priya')
  await s.owner.client.mutation(api.memberships.inviteByEmail, {
    businessId: s.businessId,
    email: priya.email,
    role: 'subcontractor',
  })
  await priya.client.mutation(api.memberships.claimInvitations, {})
  const priyaView = await priya.client.query(api.notes.listForJob, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(priyaView).toHaveLength(0)
})

test('a subcontractor cannot read or write notes on a job assigned to someone else without canViewAllJobs', async () => {
  const s = await setupBusinessWithSub('jobnotes-locked')
  const noteId = await s.owner.client.mutation(api.notes.create, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    title: 'Owner-only job note',
  })

  // Row path: a hidden note reads as no note at all.
  const notes = await s.sub.client.query(api.notes.listForJob, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(notes).toHaveLength(0)
  expect(
    await s.sub.client.query(api.notes.get, { businessId: s.businessId, noteId }),
  ).toBeNull()

  // Body path: the sync endpoints are gated separately from the row queries.
  await expectRejected(
    () => s.sub.client.query(api.notesSync.getSnapshot, { id: noteId }),
    'NOT_FOUND',
  )

  // Write path: attaching a note to an invisible job is NOT_FOUND, as jobs.get is.
  await expectRejected(
    () =>
      s.sub.client.mutation(api.notes.create, {
        businessId: s.businessId,
        jobId: s.ownerJobId,
        title: 'Sneaky',
      }),
    'NOT_FOUND',
  )
})

test('photos can be attached to and removed from a job by whoever can edit it, and read access follows job visibility', async () => {
  const s = await setupBusinessWithSub('jobphotos')

  const uploadUrl = await s.owner.client.mutation(api.jobs.generateUploadUrl, {
    businessId: s.businessId,
  })
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: pngBytes,
  })
  const { storageId } = (await uploadRes.json()) as { storageId: Id<'_storage'> }

  await s.owner.client.mutation(api.jobs.addPhoto, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    storageId,
  })

  const photos = await s.owner.client.query(api.jobs.photos, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(photos).toHaveLength(1)
  expect(photos[0].url).toBeTruthy()

  // The sub can see the job (they're a member) but cannot see its photos
  // without canViewAllJobs, since it isn't their job.
  const subView = await s.sub.client.query(api.jobs.photos, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(subView).toHaveLength(0)

  // Nor can they attach or remove one.
  await expectRejected(
    () =>
      s.sub.client.mutation(api.jobs.addPhoto, {
        businessId: s.businessId,
        jobId: s.ownerJobId,
        storageId,
      }),
    'NO_ACCESS',
  )
  await expectRejected(
    () =>
      s.sub.client.mutation(api.jobs.removePhoto, {
        businessId: s.businessId,
        jobId: s.ownerJobId,
        photoId: photos[0]._id,
      }),
    'NO_ACCESS',
  )

  await s.owner.client.mutation(api.jobs.removePhoto, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    photoId: photos[0]._id,
  })
  const afterRemove = await s.owner.client.query(api.jobs.photos, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(afterRemove).toHaveLength(0)
})

test('a job can be marked completed, cancelled, and reopened as booked', async () => {
  const s = await setupBusinessWithSub('jobstatus')

  await s.owner.client.mutation(api.jobs.complete, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  let job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(job?.status).toBe('completed')

  await s.owner.client.mutation(api.jobs.update, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
    status: 'booked',
  })
  job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(job?.status).toBe('booked')

  await s.owner.client.mutation(api.jobs.cancel, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(job?.status).toBe('cancelled')

  // Someone not assigned to the job, and not the owner, cannot change its
  // status at all.
  const outsider = await signUpActor(uniqueEmail('jobstatus-outsider'), FIXTURE_PASSWORD, 'Outsider')
  await expectRejected(
    () =>
      outsider.client.mutation(api.jobs.update, {
        businessId: s.businessId,
        jobId: s.ownerJobId,
        status: 'booked',
      }),
    'NO_ACCESS',
  )
})

test('cancelling a job from the status menu asks for confirmation first, with a friendly and accurate message', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('jobstatus-ui')
  const businesses = await s.owner.client.query(api.businesses.listForUser, {})
  const slug = businesses.find((b) => b.businessId === s.businessId)!.slug

  await signInViaUi(page, s.owner.email)
  await page.goto(`/${slug}/schedule`)

  await page.getByText('Termite Inspection').first().click()
  const detail = page.getByRole('dialog')
  await expect(detail).toBeVisible()

  await detail.getByRole('button', { name: 'Change job status' }).click()
  await page.getByRole('menuitem', { name: 'Cancelled' }).click()

  // The confirmation is specific to this job, not a generic warning, and
  // honest that nothing is actually deleted.
  const confirm = page.getByRole('alertdialog')
  await expect(confirm.getByText('Cancel this job?')).toBeVisible()
  await expect(confirm.getByText(/Termite Inspection for J\. Nguyen/)).toBeVisible()
  await expect(confirm.getByText(/Nothing is deleted/)).toBeVisible()

  // Backing out changes nothing.
  await confirm.getByRole('button', { name: 'Keep job' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(detail.getByText('Booked')).toBeVisible()

  // Confirming actually cancels it.
  await detail.getByRole('button', { name: 'Change job status' }).click()
  await page.getByRole('menuitem', { name: 'Cancelled' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel job' }).click()

  await expect(detail.getByText('Cancelled')).toBeVisible()
  const job = await s.owner.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId: s.ownerJobId,
  })
  expect(job?.status).toBe('cancelled')
})
