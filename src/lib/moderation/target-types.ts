// What can be reported, as plain data with no imports, so any module can read it at load time without pulling in the moderation code (and its imports
// of posts, media and the romance mode) and closing an import cycle. The behaviour for each target is in targets.ts.

export const REPORT_TARGETS = ['USER', 'MESSAGE', 'SHIP_POST', 'COMMENT', 'SPARK', 'ROMANCE_PROFILE', 'LFG_POST', 'IDEA', 'EXTERNAL_HACKATHON', 'MEDIA', 'EVIDENCE_CLAIM'] as const
/** What people may report; MEDIA is filed by the platform only, and a claim to a repository is disputed through its own route (POST /api/github/repos/{id}/dispute), which checks the disputer has work there. */
export const USER_REPORTABLE_TARGETS = REPORT_TARGETS.filter((target) => target !== 'MEDIA' && target !== 'EVIDENCE_CLAIM')
export const CONTENT_TARGETS = REPORT_TARGETS.filter((target) => target !== 'USER')
