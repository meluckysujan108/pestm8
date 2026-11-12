/**
 * Hands a small text file made on the device (a CSV export) to the person.
 *
 * On a phone it goes to the share sheet, where "Save to Files", Mail and
 * Numbers are: a link with `download` does nothing useful in an app opened
 * from the Home Screen on iOS, and can leave it on a blank page. Anywhere
 * with a mouse it is an ordinary download.
 *
 * `'cancelled'` is the share sheet closed with nothing chosen: nothing went,
 * and nothing went wrong. Anything else that fails is thrown.
 */
export async function saveTextFile(
  name: string,
  text: string,
  type = 'text/csv',
): Promise<'shared' | 'saved' | 'cancelled'> {
  // A byte-order mark, so Excel reads the file as UTF-8 (a curly apostrophe
  // in a client's name is otherwise three wrong characters).
  const file = new File(['﻿', text], name, { type })

  const touch = window.matchMedia('(pointer: coarse)').matches
  if (touch && typeof navigator.canShare === 'function') {
    const data = { files: [file], title: name }
    if (navigator.canShare(data)) {
      try {
        await navigator.share(data)
        return 'shared'
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError')
          return 'cancelled'
        throw error
      }
    }
  }

  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  // After the click has been acted on: revoking in the same tick can cancel
  // the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'saved'
}
