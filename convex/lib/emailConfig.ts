/**
 * Whether this deployment can send email at all.
 *
 * Both are required: Resend refuses a `from` that is a bare display name, so a
 * key without a sending address fails every send it is asked for. One
 * definition, read by the action that sends, the pipeline that schedules
 * sends, and the query that explains why a delivery is still waiting — three
 * readers that disagreed about "configured" would each tell a different story
 * about the same row.
 */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL)
}

/**
 * The address account emails come from (password reset, "your password was
 * changed"), or null when this deployment cannot send them. A separate
 * address from reports' on purpose: a report comes from the business and can
 * be replied to; an account email is from PestM8 itself, and nobody reads
 * replies to it (`RESEND_ACCOUNT_FROM_EMAIL=noreply@…`). A bare address, like
 * `RESEND_FROM_EMAIL`: the sender adds the name.
 */
export function accountEmailFrom(): string | null {
  const from = process.env.RESEND_ACCOUNT_FROM_EMAIL
  return process.env.RESEND_API_KEY && from ? from : null
}
