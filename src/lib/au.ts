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

/**
 * What each state calls the licence a technician prints on their reports —
 * the label on the field, so an owner types the number from the card they
 * hold rather than wondering which one is meant.
 */
export const LICENCE_LABEL: Record<string, string> = {
  WA: 'Pest management technician licence',
  NSW: 'Pest management technician licence',
  QLD: 'Pest management technician licence (PMT)',
  VIC: 'Pest control licence',
  SA: 'Pest controller licence',
  TAS: 'Pest control operator licence',
  NT: 'Pest management technician licence',
  ACT: 'Pest management technician licence',
}

/**
 * The state a phone's clock says it is in — a first guess for set-up, one
 * tap to change. Only a guess: Sydney time is NSW and the ACT alike, and a
 * phone on another country's time guesses nothing.
 */
const STATE_BY_TIMEZONE: Record<string, string> = {
  'Australia/Perth': 'WA',
  'Australia/Eucla': 'WA',
  'Australia/West': 'WA',
  'Australia/Darwin': 'NT',
  'Australia/North': 'NT',
  'Australia/Brisbane': 'QLD',
  'Australia/Lindeman': 'QLD',
  'Australia/Queensland': 'QLD',
  'Australia/Adelaide': 'SA',
  'Australia/South': 'SA',
  // Broken Hill keeps Adelaide's clock but is in New South Wales.
  'Australia/Broken_Hill': 'NSW',
  'Australia/Yancowinna': 'NSW',
  'Australia/Sydney': 'NSW',
  'Australia/NSW': 'NSW',
  'Australia/Lord_Howe': 'NSW',
  'Australia/LHI': 'NSW',
  'Australia/Canberra': 'ACT',
  'Australia/ACT': 'ACT',
  'Australia/Melbourne': 'VIC',
  'Australia/Victoria': 'VIC',
  'Australia/Hobart': 'TAS',
  'Australia/Tasmania': 'TAS',
  'Australia/Currie': 'TAS',
}

export function stateFromTimeZone(timeZone: string | undefined): string | null {
  return (timeZone && STATE_BY_TIMEZONE[timeZone]) || null
}
