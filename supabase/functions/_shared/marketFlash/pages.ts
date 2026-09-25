// pdftotext -layout / pdf.js layout text: pages are separated by form feed.
export function splitPages(text: string): string[] {
  return text.split("\f");
}
