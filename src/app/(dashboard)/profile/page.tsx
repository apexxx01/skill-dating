"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { User, Settings, Mail, MapPin, Clock, Globe, Github, Linkedin, Twitter, Award, Zap, FolderGit2, Users, Trophy, Code, Edit2, ChevronDown, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";

const mockUser = {
  id: "1",
  name: "Sarah Chen",
  username: "sarahchen",
  email: "sarah@example.com",
  image: null,
  bio: "Full-stack engineer passionate about building developer tools and AI-powered applications. Currently exploring the intersection of LLMs and code search.",
  headline: "Full Stack Engineer | Building NeuralSearch",
  location: "San Francisco, CA",
  timezone: "America/Los_Angeles",
  availability: "Open to collaboration",
  builderRole: "Full Stack Engineer",
  website: "https://sarahchen.dev",
  githubUsername: "sarahchen",
  twitterUsername: "sarahchen_dev",
  linkedinUrl: "https://linkedin.com/in/sarahchen",
  xp: 12840,
  rank: 247,
  reputationScore: 892,
  verificationLevel: "GITHUB",
  skills: [
    { name: "TypeScript", level: 5, category: "Language" },
    { name: "React", level: 5, category: "Frontend" },
    { name: "Node.js", level: 4, category: "Backend" },
    { name: "PostgreSQL", level: 4, category: "Database" },
    { name: "Python", level: 3, category: "Language" },
    { name: "Docker", level: 4, category: "DevOps" },
    { name: "AWS", level: 3, category: "Cloud" },
    { name: "GraphQL", level: 3, category: "API" },
  ],
  projects: [
    { name: "NeuralSearch", status: "BUILDING", description: "AI-powered code search for developers" },
    { name: "TaskFlow", status: "SHIPPED", description: "Real-time collaborative task management" },
  ],
  achievements: [
    { name: "First Ship", description: "Shipped your first project", icon: Award, xp: 500, earnedAt: "2024-01-15" },
    { name: "Hackathon Winner", description: "Won HackMIT 2023", icon: Trophy, xp: 1000, earnedAt: "2023-09-15" },
    { name: "Open Source Contributor", description: "10+ merged PRs", icon: Code, xp: 300, earnedAt: "2024-03-20" },
  ],
};

export default function ProfilePage() {
  const [activeTab, setActiveTab] = useState("overview");
  const isOwnProfile = true;

  return (
    <div className="container-padding section-spacing">
      <div className="mb-8">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="font-display text-display-md font-bold tracking-tight">Profile</h1>
            <p className="text-muted-foreground mt-1">Your builder passport - showcase your skills, projects, and achievements</p>
          </div>
          {isOwnProfile && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <MoreHorizontal className="h-4 w-4 mr-2" aria-hidden="true" />
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Profile Actions</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <a href="/profile/edit"><Edit2 className="h-4 w-4 mr-2" aria-hidden="true" />Edit Profile</a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href="/settings"><Settings className="h-4 w-4 mr-2" aria-hidden="true" />Settings</a>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive">Delete Account</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-4">
        <div className="lg:col-span-1 space-y-6">
          <ProfileCard user={mockUser} isOwn={isOwnProfile} />
          <StatsCard user={mockUser} />
          <VerificationCard user={mockUser} />
        </div>

        <div className="lg:col-span-3">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="skills">Skills</TabsTrigger>
              <TabsTrigger value="projects">Projects</TabsTrigger>
              <TabsTrigger value="achievements">Achievements</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>

            <TabsContent value="overview">
              <OverviewTab user={mockUser} />
            </TabsContent>

            <TabsContent value="skills">
              <SkillsTab skills={mockUser.skills} />
            </TabsContent>

            <TabsContent value="projects">
              <ProjectsTab projects={mockUser.projects} />
            </TabsContent>

            <TabsContent value="achievements">
              <AchievementsTab achievements={mockUser.achievements} />
            </TabsContent>

            <TabsContent value="activity">
              <ActivityTab />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

function ProfileCard({ user, isOwn }: { user: typeof mockUser; isOwn: boolean }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="text-center space-y-4">
          <Avatar className="mx-auto h-24 w-24">
            <AvatarFallback className="text-3xl font-bold">{user.name.charAt(0)}</AvatarFallback>
          </Avatar>
          <div>
            <h2 className="text-xl font-bold">{user.name}</h2>
            <p className="text-muted-foreground">@{user.username}</p>
            {user.builderRole && <p className="text-sm text-primary mt-1">{user.builderRole}</p>}
          </div>
          <div className="flex items-center justify-center gap-1 text-sm text-muted-foreground">
            {user.location && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />{user.location}</span>}
            {user.availability && <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden="true" />{user.availability}</span>}
          </div>
          {user.bio && <p className="text-sm text-muted-foreground line-clamp-3">{user.bio}</p>}
          <div className="flex items-center justify-center gap-2 pt-2 border-t">
            {user.website && <a href={user.website} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline flex items-center gap-1"><Globe className="h-3.5 w-3.5" aria-hidden="true" />Website</a>}
            {user.githubUsername && <a href={`https://github.com/${user.githubUsername}`} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline flex items-center gap-1"><Github className="h-3.5 w-3.5" aria-hidden="true" />GitHub</a>}
            {user.twitterUsername && <a href={`https://twitter.com/${user.twitterUsername}`} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline flex items-center gap-1"><Twitter className="h-3.5 w-3.5" aria-hidden="true" />Twitter</a>}
            {user.linkedinUrl && <a href={user.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline flex items-center gap-1"><Linkedin className="h-3.5 w-3.5" aria-hidden="true" />LinkedIn</a>}
          </div>
          {isOwn && (
            <Button asChild variant="outline" className="w-full">
              <a href="/profile/edit"><Edit2 className="h-4 w-4 mr-2" aria-hidden="true" />Edit Profile</a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatsCard({ user }: { user: typeof mockUser }) {
  const xpProgress = Math.min((user.xp % 5000) / 5000 * 100, 100);
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5 text-warning-500" aria-hidden="true" />Progression</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex items-center justify-between text-sm mb-1">
            <span>Total XP</span>
            <span className="font-bold text-warning-500">{user.xp.toLocaleString()}</span>
          </div>
          <Progress value={xpProgress} className="h-2" />
          <p className="text-xs text-muted-foreground mt-1">Rank #{user.rank} globally</p>
        </div>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="p-3 rounded-lg bg-muted/50">
            <p className="text-2xl font-bold">{user.projects.length}</p>
            <p className="text-xs text-muted-foreground">Projects</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <p className="text-2xl font-bold">{user.achievements.length}</p>
            <p className="text-xs text-muted-foreground">Achievements</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <p className="text-2xl font-bold">{user.reputationScore}</p>
            <p className="text-xs text-muted-foreground">Reputation</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function VerificationCard({ user }: { user: typeof mockUser }) {
  const verifications = [
    { label: "Email", verified: true, icon: Mail },
    { label: "GitHub", verified: user.verificationLevel === "GITHUB", icon: Github },
    { label: "Portfolio", verified: false, icon: Globe },
    { label: "Identity", verified: false, icon: User },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><User className="h-5 w-5 text-primary" aria-hidden="true" />Verification</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {verifications.map((v) => (
          <div key={v.label} className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm">
              <v.icon className={cn("h-4 w-4", v.verified ? "text-success-500" : "text-muted-foreground")} aria-hidden="true" />
              {v.label}
            </span>
            <Badge variant={v.verified ? "secondary" : "outline"} className={cn(v.verified ? "bg-success-500/10 text-success-500" : "")}>
              {v.verified ? "Verified" : "Verify"}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function OverviewTab({ user }: { user: typeof mockUser }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><User className="h-5 w-5 text-primary" aria-hidden="true" />About</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground whitespace-pre-wrap">{user.bio}</p>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FolderGit2 className="h-5 w-5 text-primary" aria-hidden="true" />Current Projects</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {user.projects.map((project) => (
              <div key={project.name} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                <div>
                  <p className="font-medium">{project.name}</p>
                  <p className="text-sm text-muted-foreground">{project.description}</p>
                </div>
                <Badge variant={project.status === "SHIPPED" ? "secondary" : "outline"} className={cn(project.status === "SHIPPED" && "bg-success-500/10 text-success-500")}>
                  {project.status}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Award className="h-5 w-5 text-warning-500" aria-hidden="true" />Recent Achievements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {user.achievements.slice(0, 3).map((achievement) => (
              <div key={achievement.name} className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10 text-yellow-500">
                  <achievement.icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <p className="font-medium">{achievement.name}</p>
                  <p className="text-sm text-muted-foreground">{achievement.description}</p>
                </div>
                <span className="text-xs text-warning-500 font-medium ml-auto">+{achievement.xp} XP</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SkillsTab({ skills }: { skills: typeof mockUser.skills }) {
  const categories = [...new Set(skills.map(s => s.category))];

  return (
    <div className="space-y-6">
      {categories.map((category) => {
        const categorySkills = skills.filter(s => s.category === category);
        return (
          <Card key={category}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Code className="h-5 w-5 text-primary" aria-hidden="true" />{category}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {categorySkills.map((skill) => (
                  <Badge key={skill.name} variant="outline" className="gap-1 px-3 py-1.5">
                    {skill.name}
                    <span className="flex items-center gap-0.5 text-xs">
                      {Array.from({ length: 5 }, (_, i) => (
                        <span key={i} className={cn("h-1.5 w-1.5 rounded-sm", i < skill.level ? "bg-primary" : "bg-muted")} />
                      ))}
                    </span>
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function ProjectsTab({ projects }: { projects: typeof mockUser.projects }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {projects.map((project) => (
        <Card key={project.name}>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle>{project.name}</CardTitle>
                <CardDescription>{project.description}</CardDescription>
              </div>
              <Badge variant={project.status === "SHIPPED" ? "secondary" : "outline"} className={cn(project.status === "SHIPPED" && "bg-success-500/10 text-success-500")}>
                {project.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" asChild>
              <a href={`/projects/${project.name.toLowerCase().replace(/\s+/g, "-")}`}>View Project</a>
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AchievementsTab({ achievements }: { achievements: typeof mockUser.achievements }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {achievements.map((achievement) => (
        <Card key={achievement.name} className="text-center">
          <CardContent className="py-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-yellow-500/10 text-yellow-500 mx-auto mb-4">
              <achievement.icon className="h-8 w-8" aria-hidden="true" />
            </div>
            <h3 className="font-semibold">{achievement.name}</h3>
            <p className="text-sm text-muted-foreground mt-1">{achievement.description}</p>
            <p className="text-xs text-warning-500 font-medium mt-2">+{achievement.xp} XP</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Earned {formatDistanceToNow(new Date(achievement.earnedAt), { addSuffix: true })}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ActivityTab() {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <Users className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
        <h3 className="text-lg font-semibold mb-2">Activity Feed</h3>
        <p className="text-muted-foreground mb-4">Your recent builds, collaborations, and achievements</p>
        <Button variant="outline">View Full Activity</Button>
      </CardContent>
    </Card>
  );
}

