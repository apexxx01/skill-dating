"use client";

import { Trophy, Plus, Search, Filter, Calendar, MapPin, Clock, Users, Award } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { formatDistanceToNow } from "date-fns";

const mockHackathons = [
  { id: "1", name: "HackMIT 2024", description: "MIT's annual hackathon for students worldwide", startDate: new Date(Date.now() + 1000 * 60 * 60 * 48), endDate: new Date(Date.now() + 1000 * 60 * 60 * 72), location: "Cambridge, MA", status: "UPCOMING", prizePool: "$50,000", maxTeamSize: 5, registered: true, technologies: ["AI/ML", "Web", "Mobile", "Hardware"] },
  { id: "2", name: "ETHGlobal Singapore", description: "Build the future of Ethereum in Singapore", startDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10), endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 12), location: "Singapore", status: "UPCOMING", prizePool: "$100,000", maxTeamSize: 4, registered: false, technologies: ["Blockchain", "Web3", "Smart Contracts"] },
  { id: "3", name: "AI Hack Week", description: "Week-long AI-focused virtual hackathon", startDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30), endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 37), location: "Remote", status: "UPCOMING", prizePool: "$25,000", maxTeamSize: 5, registered: false, technologies: ["AI/ML", "LLMs", "Computer Vision"] },
  { id: "4", name: "HackNYU 2024", description: "NYU's flagship hackathon", startDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5), endDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3), location: "New York, NY", status: "ENDED", prizePool: "$30,000", maxTeamSize: 4, registered: true, technologies: ["Web", "Mobile", "FinTech"] },
];

export default function HackathonsPage() {
  return (
    <div className="container-padding section-spacing">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-display-md font-bold tracking-tight">Hackathons</h1>
          <p className="text-muted-foreground mt-1">Discover and participate in hackathons</p>
        </div>
        <Button asChild>
          <a href="/hackathons/new"><Plus className="h-4 w-4 mr-2" aria-hidden="true" />Create Hackathon</a>
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input placeholder="Search hackathons..." className="pl-10" />
        </div>
        <Button variant="outline"><Filter className="h-4 w-4 mr-2" aria-hidden="true" />Filters</Button>
      </div>

      <Tabs defaultValue="upcoming" className="space-y-4">
        <TabsList>
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="ended">Ended</TabsTrigger>
          <TabsTrigger value="my-hackathons">My Hackathons</TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {mockHackathons.filter(h => h.status === "UPCOMING").map((hackathon) => (
              <HackathonCard key={hackathon.id} hackathon={hackathon} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="active">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {mockHackathons.filter(h => h.status === "ACTIVE").map((hackathon) => (
              <HackathonCard key={hackathon.id} hackathon={hackathon} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="ended">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {mockHackathons.filter(h => h.status === "ENDED").map((hackathon) => (
              <HackathonCard key={hackathon.id} hackathon={hackathon} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="my-hackathons">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {mockHackathons.filter(h => h.registered).map((hackathon) => (
              <HackathonCard key={hackathon.id} hackathon={hackathon} />
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function HackathonCard({ hackathon }: { hackathon: typeof mockHackathons[0] }) {
  const statusConfig: Record<string, { color: string; label: string }> = {
    UPCOMING: { color: "bg-blue-500/10 text-blue-500", label: "Upcoming" },
    ACTIVE: { color: "bg-success-500/10 text-success-500 animate-pulse", label: "Live Now" },
    ENDED: { color: "bg-muted text-muted-foreground", label: "Ended" },
    CANCELLED: { color: "bg-destructive/10 text-destructive", label: "Cancelled" },
  };

  const config = statusConfig[hackathon.status] || statusConfig.UPCOMING;

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-lg">{hackathon.name}</CardTitle>
            <CardDescription>{hackathon.description}</CardDescription>
          </div>
          <Badge variant="secondary" className={cn("mt-0.5", config.color)}>
            {config.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="flex items-center gap-1 text-muted-foreground">
            <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
            {formatDistanceToNow(hackathon.startDate, { addSuffix: true })}
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            {hackathon.location}
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            Teams of {hackathon.maxTeamSize}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Award className="h-3.5 w-3.5 text-warning-500" aria-hidden="true" />
          <span className="font-medium text-warning-500">{hackathon.prizePool}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {hackathon.technologies.slice(0, 3).map((tech) => (
            <Badge key={tech} variant="outline" className="text-xs">{tech}</Badge>
          ))}
          {hackathon.technologies.length > 3 && (
            <Badge variant="secondary" className="text-xs">+{hackathon.technologies.length - 3}</Badge>
          )}
        </div>
      </CardContent>
      <CardFooter className="flex items-center justify-between border-t pt-3">
        {hackathon.registered ? (
          <Button variant="default" size="sm">My Team</Button>
        ) : hackathon.status === "UPCOMING" ? (
          <Button variant="default" size="sm">Register</Button>
        ) : (
          <Button variant="outline" size="sm">View Results</Button>
        )}
      </CardFooter>
    </Card>
  );
}