export type PdfTextExtractor = (raw: Buffer) => string | null | undefined

export const SIDECAR_SUFFIX = '.txt'

export function extractDocumentText(
  raw: Buffer,
  mime: string,
  opts: { pdfTextExtractor?: PdfTextExtractor | null } = {},
): string | null {
  const normalized = mime.toLowerCase().trim()
  if (normalized === 'application/pdf')
    return extractPdfText(raw, opts.pdfTextExtractor ?? null)
  try {
    return raw.toString('utf8')
  } catch {
    return null
  }
}

export function extractPdfText(
  raw: Buffer,
  extractor: PdfTextExtractor | null = null,
): string | null {
  if (!extractor) return null
  try {
    const text = extractor(raw)
    return text && text.trim() ? text : null
  } catch {
    return null
  }
}
