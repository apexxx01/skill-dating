"use client";

import { Users, Plus, Search, Filter, Code, Trophy, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const mockTeams = [
  { id: "1", name: "AI Research Collective", description: "Building the future of AI research tools", members: 4, maxSize: 5, isRecruiting: true, lookingFor: ["ML Engineer", "Backend Engineer"], owner: "Sarah Chen" },
  { id: "2", name: "Web3 Builders Guild", description: "Decentralized applications and protocols", members: 3, maxSize: 5, isRecruiting: true, lookingFor: ["Smart Contract Dev", "Frontend Dev"], owner: "Marcus Rodriguez" },
];

export default function TeamsPage() {
  return (
    <div className="container-padding section-spacing">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-display-md font-bold tracking-tight">Teams</h1>
          <p className="text-muted-foreground mt-1">Your teams and team opportunities</p>
        </div>
        <Button asChild>
          <a href="/teams/new"><Plus className="h-4 w-4 mr-2" aria-hidden="true" />Create Team</a>
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input placeholder="Search teams..." className="pl-10" />
        </div>
        <Button variant="outline"><Filter className="h-4 w-4 mr-2" aria-hidden="true" />Filters</Button>
      </div>

      <Tabs defaultValue="my-teams" className="space-y-4">
        <TabsList>
          <TabsTrigger value="my-teams">My Teams</TabsTrigger>
          <TabsTrigger value="discover">Discover Teams</TabsTrigger>
          <TabsTrigger value="applications">Applications</TabsTrigger>
        </TabsList>

        <TabsContent value="my-teams">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {mockTeams.map((team) => (
              <TeamCard key={team.id} team={team} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="discover">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {mockTeams.map((team) => (
              <TeamCard key={team.id} team={team} showJoin />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="applications">
          <Card>
            <CardContent className="py-12 text-center">
              <Shield className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
              <h3 className="text-lg font-semibold mb-2">Team Applications</h3>
              <p className="text-muted-foreground mb-4">Your pending and past team applications</p>
              <Button>View Applications</Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TeamCard({ team, showJoin }: { team: typeof mockTeams[0]; showJoin?: boolean }) {
  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-lg">{team.name}</CardTitle>
            <CardDescription>{team.description}</CardDescription>
          </div>
          {team.isRecruiting && (
            <Badge variant="secondary" className="bg-success-500/10 text-success-500 mt-0.5">Recruiting</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" aria-hidden="true" />{team.members}/{team.maxSize}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {team.lookingFor.map((role) => (
            <Badge key={role} variant="outline" className="text-xs">{role}</Badge>
          ))}
        </div>
      </CardContent>
      <CardFooter className="flex items-center justify-between border-t pt-3">
        <div className="flex items-center gap-2">
          <Avatar className="h-7 w-7"><AvatarFallback className="text-xs">{team.owner.charAt(0)}</AvatarFallback></Avatar>
          <span className="text-sm text-muted-foreground">{team.owner}</span>
        </div>
        {showJoin ? (
          <Button variant="outline" size="sm">Apply</Button>
        ) : (
          <Button variant="outline" size="sm">View</Button>
        )}
      </CardFooter>
    </Card>
  );
}