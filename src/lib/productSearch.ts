import { matchesAllWords } from './searchMatch'

/**
 * Finding a product on the Products page as it is typed into.
 *
 * The list is read whole (`products.list` is bounded at MAX_PRODUCTS), so the
 * search runs on the phone over what is already there — the same choice the
 * Clients page made, for the same reason: every keystroke is instant, and it
 * works with no signal over the products kept on the phone.
 *
 * What a technician types is rarely the label's exact wording. They type the
 * brand ("termidor"), the active ("fipronil", which lives in the
 * description), the maker's site ("bayer", from the link) or what the file
 * was called ("sds"), so all four are searched, every word anywhere, in any
 * order (`matchesAllWords`).
 */

export type SearchableProduct = {
  name: string
  description: string | null
  url: string | null
  pdf: { fileName: string } | null
}

/**
 * A product link split for showing: the host without a leading "www.", and
 * everything after it (path, query, fragment) with its escapes decoded where
 * they decode. Null for a link that does not parse — the server only stores
 * ones that do, but a kept copy on the phone is read back from storage.
 *
 * The host is kept apart so a page can always show it whole and let the rest
 * truncate: the host is the part that says whose site a link opens.
 */
export function linkParts(url: string): { host: string; rest: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.host.replace(/^www\./i, '')
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  const raw = `${path}${parsed.search}${parsed.hash}`
  let rest = raw
  try {
    rest = decodeURI(raw)
  } catch {
    // A stray "%" that is not an escape: show it as stored.
  }
  return { host, rest }
}

/** Everything a search looks through, as one line. */
export function productSearchText(product: SearchableProduct): string {
  return [
    product.name,
    product.description,
    product.url ? linkParts(product.url)?.host : null,
    product.pdf?.fileName,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ')
}

export function matchesProductSearch(
  product: SearchableProduct,
  query: string,
): boolean {
  return matchesAllWords(productSearchText(product), query)
}

/** The products a search leaves, in the order given. Blank keeps them all. */
export function filterProducts<T extends SearchableProduct>(
  products: ReadonlyArray<T>,
  query: string,
): Array<T> {
  if (query.trim() === '') return [...products]
  return products.filter((product) => matchesProductSearch(product, query))
}
