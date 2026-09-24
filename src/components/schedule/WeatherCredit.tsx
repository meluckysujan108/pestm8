/**
 * The credit both forecast sources ask for (CC BY 4.0), shown next to where
 * their numbers are: Open-Meteo, and MET Norway, which answers when Open-Meteo
 * will not (convex/weather.ts). Quiet, but on screen — a credit buried in a
 * settings page is not one.
 */
export function WeatherCredit({ className = '' }: { className?: string }) {
  const link = 'underline decoration-hairline underline-offset-2'
  return (
    <p className={`text-caption text-muted ${className}`}>
      Weather data by{' '}
      <a
        href="https://open-meteo.com/"
        target="_blank"
        rel="noopener noreferrer"
        className={link}
      >
        Open-Meteo.com
      </a>{' '}
      and{' '}
      <a
        href="https://www.met.no/en"
        target="_blank"
        rel="noopener noreferrer"
        className={link}
      >
        MET Norway
      </a>
    </p>
  )
}
