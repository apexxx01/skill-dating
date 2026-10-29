import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { isReceiptId } from '@/lib/evidence/receipt-id'
import { applyRecheck, checkSource } from '@/lib/evidence/receipts'
import { engineEvidenceVisible } from '@/lib/evidence/sync'
import { GitHubBudget, GitHubBudgetExceededError, GitHubRateLimitedError, GitHubUnavailableError, openGitHub, resolveGitHubAuth } from '@/lib/infra/github'

// POST /api/receipts/{id}/recheck: the owner asks for one of their receipts to be checked against GitHub now. The source is read again (with the owner's own
// GitHub sign-in when there is one) and the receipt's status and the weight of the evidence behind it are updated; nothing is deleted. Another person's
// receipt is 404 RECEIPT_NOT_FOUND, like one that does not exist; a revoked one is 410 RECEIPT_REVOKED; without the GITHUB_SYNC consent 403
// GITHUB_SYNC_CONSENT_REQUIRED; GitHub refusing or limiting is 503 SERVICE_UNAVAILABLE. Five a minute.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').slice(-2)[0]
  if (!isReceiptId(id)) return createApiError('RECEIPT_NOT_FOUND')
  const receipt = await prisma.evidenceReceipt.findUnique({ where: { id }, select: { id: true, userId: true, status: true, sourceRef: true, facts: true, repoEvidenceId: true } })
  if (!receipt || receipt.userId !== user.id) return createApiError('RECEIPT_NOT_FOUND')
  if (receipt.status === 'REVOKED') return createApiError('RECEIPT_REVOKED')
  if (!(await engineEvidenceVisible(prisma, user.id))) return createApiError('GITHUB_SYNC_CONSENT_REQUIRED')

  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { clerkId: true } })
  const { api } = openGitHub(await resolveGitHubAuth({ userId: user.id, clerkId: row.clerkId }), new GitHubBudget(10))
  let status
  try {
    status = await checkSource(api, receipt)
  } catch (error) {
    if (error instanceof GitHubBudgetExceededError || error instanceof GitHubRateLimitedError || error instanceof GitHubUnavailableError) return createApiError('SERVICE_UNAVAILABLE')
    throw error
  }
  const now = new Date()
  await applyRecheck(prisma, receipt, status, now)
  return createApiResponse({ receipt: { id: receipt.id, status, lastCheckedAt: now.toISOString(), previousStatus: receipt.status } })
}, { rateLimit: { windowMs: 60000, maxRequests: 5, keyPrefix: 'receipts:recheck' } })
