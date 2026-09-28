"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Users, FolderGit2, Trophy, Search, Filter, Grid, List } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";

const tabs = [
  { value: "builders", label: "Builders", icon: Users, count: 1247 },
  { value: "projects", label: "Projects", icon: FolderGit2, count: 389 },
  { value: "teams", label: "Teams", icon: Trophy, count: 156 },
  { value: "hackathons", label: "Hackathons", icon: Trophy, count: 23 },
];

const mockBuilders = [
  { id: "1", name: "Sarah Chen", role: "Full Stack Engineer", location: "San Francisco, CA", skills: ["React", "Node.js", "PostgreSQL", "TypeScript"], match: 94, avatar: null },
  { id: "2", name: "Marcus Rodriguez", role: "ML Engineer", location: "New York, NY", skills: ["Python", "PyTorch", "MLOps", "Kubernetes"], match: 87, avatar: null },
  { id: "3", name: "Priya Patel", role: "DevOps Engineer", location: "Austin, TX", skills: ["AWS", "Terraform", "Kubernetes", "Go"], match: 82, avatar: null },
  { id: "4", name: "Alex Kim", role: "Frontend Engineer", location: "Seattle, WA", skills: ["React", "Next.js", "Tailwind", "TypeScript"], match: 79, avatar: null },
  { id: "5", name: "Jordan Williams", role: "Backend Engineer", location: "Remote", skills: ["Go", "PostgreSQL", "Redis", "GraphQL"], match: 75, avatar: null },
  { id: "6", name: "Emily Davis", role: "Product Designer", location: "Los Angeles, CA", skills: ["Figma", "React", "Design Systems", "Prototyping"], match: 71, avatar: null },
];

export default function DiscoverPage() {
  const [activeTab, setActiveTab] = useState("builders");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  return (
    <div className="container-padding section-spacing">
      <div className="mb-8">
        <h1 className="font-display text-display-md font-bold tracking-tight">Discover</h1>
        <p className="text-muted-foreground mt-1">Find builders, projects, teams, and hackathons to collaborate with.</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-8">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder="Search builders, projects, teams..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button variant="outline" className="gap-2">
          <Filter className="h-4 w-4" aria-hidden="true" />
          Filters
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.value} value={tab.value} className="gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
                <Icon className="h-4 w-4" aria-hidden="true" />
                {tab.label}
                <Badge variant="secondary" className="ml-auto">{tab.count}</Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="builders">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => setViewMode("grid")} aria-label="Grid view">
                <Grid className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button variant="outline" size="icon" onClick={() => setViewMode("list")} aria-label="List view">
                <List className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className={cn("gap-4", viewMode === "grid" ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" : "space-y-4")}>
            {mockBuilders.map((builder) => (
              <BuilderCard key={builder.id} builder={builder} mode={viewMode} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="projects">
          <ProjectDiscoveryPlaceholder />
        </TabsContent>

        <TabsContent value="teams">
          <TeamDiscoveryPlaceholder />
        </TabsContent>

        <TabsContent value="hackathons">
          <HackathonDiscoveryPlaceholder />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BuilderCard({ builder, mode }: { builder: typeof mockBuilders[0]; mode: "grid" | "list" }) {
  return (
    <Card className={cn("hover:shadow-md transition-shadow cursor-pointer", mode === "list" && "flex items-center")}>
      <CardContent className={cn("p-4", mode === "list" && "flex items-center gap-4 w-full")}>
        <Avatar className="h-12 w-12">
          <AvatarFallback className="text-lg font-medium">{builder.name.charAt(0)}</AvatarFallback>
        </Avatar>
        <div className={cn("flex-1 min-w-0", mode === "grid" && "mt-3")}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-base">{builder.name}</p>
              <p className="text-sm text-muted-foreground">{builder.role}</p>
              <p className="text-xs text-muted-foreground/70 flex items-center gap-1 mt-0.5">
                <span className="h-1.5 w-1.5 rounded-full bg-success-500" />
                {builder.location}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="font-bold text-builder-500">{builder.match}%</p>
              <p className="text-xs text-muted-foreground">match</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {builder.skills.slice(0, mode === "grid" ? 4 : 6).map((skill) => (
              <Badge key={skill} variant="outline" className="text-xs">
                {skill}
              </Badge>
            ))}
            {builder.skills.length > (mode === "grid" ? 4 : 6) && (
              <Badge variant="secondary" className="text-xs">
                +{builder.skills.length - (mode === "grid" ? 4 : 6)} more
              </Badge>
            )}
          </div>
          {mode === "list" && (
            <Button size="sm" variant="outline" className="mt-3">
              View Profile
            </Button>
          )}
        </div>
        {mode === "grid" && (
          <div className="border-t pt-3 mt-3">
            <Button className="w-full" size="sm">Connect</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectDiscoveryPlaceholder() {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <FolderGit2 className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
        <h3 className="text-lg font-semibold mb-2">Project Discovery</h3>
        <p className="text-muted-foreground mb-4">Browse open source projects looking for contributors</p>
        <Button>Explore Projects</Button>
      </CardContent>
    </Card>
  );
}

function TeamDiscoveryPlaceholder() {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <Trophy className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
        <h3 className="text-lg font-semibold mb-2">Team Discovery</h3>
        <p className="text-muted-foreground mb-4">Find teams looking for new members</p>
        <Button>Explore Teams</Button>
      </CardContent>
    </Card>
  );
}

function HackathonDiscoveryPlaceholder() {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <Trophy className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
        <h3 className="text-lg font-semibold mb-2">Hackathon Discovery</h3>
        <p className="text-muted-foreground mb-4">Discover upcoming and active hackathons</p>
        <Button>Explore Hackathons</Button>
      </CardContent>
    </Card>
  );
}