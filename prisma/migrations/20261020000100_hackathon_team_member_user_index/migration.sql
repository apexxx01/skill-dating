-- A person's squads across hackathons are read by user: teammates for peer reviews, pair history, reunions.
CREATE INDEX "HackathonTeamMember_userId_idx" ON "HackathonTeamMember"("userId");
