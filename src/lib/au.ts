export const AU_STATES = [
  { code: 'ACT', name: 'Australian Capital Territory' },
  { code: 'NSW', name: 'New South Wales' },
  { code: 'NT', name: 'Northern Territory' },
  { code: 'QLD', name: 'Queensland' },
  { code: 'SA', name: 'South Australia' },
  { code: 'TAS', name: 'Tasmania' },
  { code: 'VIC', name: 'Victoria' },
  { code: 'WA', name: 'Western Australia' },
] as const

export const TIMEZONE_BY_STATE: Record<string, string> = {
  ACT: 'Australia/Sydney',
  NSW: 'Australia/Sydney',
  NT: 'Australia/Darwin',
  QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide',
  TAS: 'Australia/Hobart',
  VIC: 'Australia/Melbourne',
  WA: 'Australia/Perth',
}
