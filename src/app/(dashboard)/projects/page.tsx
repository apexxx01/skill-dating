"use client";

import { FolderGit2, Plus, Search, Filter, GitBranch, Star, GitFork } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const mockProjects = [
  { id: "1", name: "NeuralSearch", description: "AI-powered code search for developers", status: "BUILDING", techStack: ["TypeScript", "React", "Node.js", "PostgreSQL"], stars: 42, forks: 8, owner: "Sarah Chen", updatedAt: "2 hours ago" },
  { id: "2", name: "TaskFlow", description: "Real-time collaborative task management", status: "SHIPPED", techStack: ["Next.js", "Tailwind", "Prisma", "tRPC"], stars: 128, forks: 24, owner: "Marcus Rodriguez", updatedAt: "1 day ago" },
  { id: "3", name: "DevDeck", description: "Developer productivity dashboard", status: "TESTING", techStack: ["React", "Electron", "TypeScript", "SQLite"], stars: 67, forks: 12, owner: "Priya Patel", updatedAt: "3 days ago" },
];

export default function ProjectsPage() {
  return (
    <div className="container-padding section-spacing">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-display-md font-bold tracking-tight">Projects</h1>
          <p className="text-muted-foreground mt-1">Your projects and collaborations</p>
        </div>
        <Button asChild>
          <a href="/projects/new"><Plus className="h-4 w-4 mr-2" aria-hidden="true" />New Project</a>
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input placeholder="Search projects..." className="pl-10" />
        </div>
        <Button variant="outline"><Filter className="h-4 w-4 mr-2" aria-hidden="true" />Filters</Button>
      </div>

      <Tabs defaultValue="all" className="space-y-4">
        <TabsList>
          <TabsTrigger value="all">All Projects</TabsTrigger>
          <TabsTrigger value="owned">Owned</TabsTrigger>
          <TabsTrigger value="member">Member Of</TabsTrigger>
          <TabsTrigger value="starred">Starred</TabsTrigger>
        </TabsList>

        <TabsContent value="all">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {mockProjects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="owned">
          <ProjectCard project={mockProjects[0]} />
        </TabsContent>

        <TabsContent value="member">
          <ProjectCard project={mockProjects[1]} />
        </TabsContent>

        <TabsContent value="starred">
          <ProjectCard project={mockProjects[2]} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProjectCard({ project }: { project: typeof mockProjects[0] }) {
  const statusColors: Record<string, string> = {
    IDEA: "bg-gray-500",
    PLANNING: "bg-blue-500",
    BUILDING: "bg-builder-500",
    TESTING: "bg-purple-500",
    SHIPPED: "bg-success-500",
    ARCHIVED: "bg-muted-foreground",
  };

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-lg">{project.name}</CardTitle>
            <CardDescription>{project.description}</CardDescription>
          </div>
          <Badge variant="secondary" className={cn("mt-0.5", statusColors[project.status] || "bg-muted")}>
            {project.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        <div className="flex flex-wrap gap-1">
          {project.techStack.slice(0, 4).map((tech) => (
            <Badge key={tech} variant="outline" className="text-xs">{tech}</Badge>
          ))}
          {project.techStack.length > 4 && (
            <Badge variant="secondary" className="text-xs">+{project.techStack.length - 4}</Badge>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-1"><Star className="h-3.5 w-3.5" aria-hidden="true" />{project.stars}</div>
          <div className="flex items-center gap-1"><GitFork className="h-3.5 w-3.5" aria-hidden="true" />{project.forks}</div>
          <div className="flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" aria-hidden="true" />Updated {project.updatedAt}</div>
        </div>
      </CardContent>
      <CardFooter className="flex items-center justify-between border-t pt-3">
        <div className="flex items-center gap-2">
          <Avatar className="h-7 w-7"><AvatarFallback className="text-xs">{project.owner.charAt(0)}</AvatarFallback></Avatar>
          <span className="text-sm text-muted-foreground">{project.owner}</span>
        </div>
        <Button variant="outline" size="sm">View</Button>
      </CardFooter>
    </Card>
  );
}