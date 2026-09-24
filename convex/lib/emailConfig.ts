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
