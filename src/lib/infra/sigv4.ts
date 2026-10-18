import { createHash, createHmac } from 'crypto'

// AWS Signature Version 4 for a presigned URL (query-string authentication), which S3 and every S3-compatible store (Cloudflare R2, MinIO) accept.
// Pure and dependency-free: the inputs are explicit, including the clock, so the unit test can reproduce AWS's published example byte for byte.

export interface PresignInput {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  /** The host the request goes to, as it appears in the Host header ("examplebucket.s3.amazonaws.com", "acct.r2.cloudflarestorage.com"). */
  host: string
  /** The absolute path, already percent-encoded per segment ("/bucket/photos/a b.png" -> "/bucket/photos/a%20b.png"). */
  path: string
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  /** Seconds the URL stays valid (1 to 604800). */
  expiresSeconds: number
  now: Date
  /** Extra headers the caller must send exactly as given (lower-case names), signed with the URL. `host` is always signed. */
  headers?: Record<string, string>
}

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest()

/** RFC 3986 percent-encoding as AWS wants it: only A-Z a-z 0-9 - _ . ~ stay as they are. */
export function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** An S3 object key as a path: each segment encoded, the slashes kept. */
export const encodeKeyPath = (key: string) => key.split('/').map(awsEncode).join('/')

const amzDate = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

/** The full presigned URL (https). */
export function presignUrl(input: PresignInput): string {
  if (!Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > 604_800) throw new Error('expiresSeconds must be 1 to 604800')
  const service = input.service ?? 's3'
  const stamp = amzDate(input.now)
  const day = stamp.slice(0, 8)
  const scope = `${day}/${input.region}/${service}/aws4_request`

  const headers: Record<string, string> = { host: input.host, ...(input.headers ?? {}) }
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort()
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ]
  const canonicalQuery = query
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')

  const canonicalRequest = [input.method, input.path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  return `https://${input.host}${input.path}?${canonicalQuery}&X-Amz-Signature=${signature}`
}
