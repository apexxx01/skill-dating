"use client";

import { useState } from "react";
import { MessageSquare, Plus, Search, Filter, Bell, MoreHorizontal, Reply, Star, Flag, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { formatDistanceToNow } from "date-fns";
import { motion } from "motion/react";

const mockConversations = [
  { id: "1", type: "DIRECT", name: "Sarah Chen", lastMessage: "Hey! I saw your project and would love to collaborate", timestamp: new Date(Date.now() - 1000 * 60 * 5), unread: 2, avatar: null, online: true },
  { id: "2", type: "GROUP", name: "AI Research Collective", lastMessage: "Marcus: The model training is complete!", timestamp: new Date(Date.now() - 1000 * 60 * 30), unread: 0, avatar: null, online: false },
  { id: "3", type: "PROJECT", name: "NeuralSearch", lastMessage: "Priya: Just deployed the new search index", timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2), unread: 1, avatar: null, online: false },
  { id: "4", type: "DIRECT", name: "Alex Kim", lastMessage: "Thanks for the code review!", timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24), unread: 0, avatar: null, online: true },
  { id: "5", type: "TEAM", name: "Web3 Builders Guild", lastMessage: "Jordan: Smart contract audit passed", timestamp: new Date(Date.now() - 1000 * 60 * 60 * 48), unread: 3, avatar: null, online: false },
];

const mockMessages = [
  { id: "1", sender: "Sarah Chen", content: "Hey! I saw your NeuralSearch project on Skill Dating and I'm really impressed with the approach you took for the vector search implementation.", timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2), isOwn: false, avatar: null },
  { id: "2", sender: "You", content: "Thanks Sarah! It was a fun challenge to optimize the similarity search. Are you working on something similar?", timestamp: new Date(Date.now() - 1000 * 60 * 60 * 1.5), isOwn: true, avatar: null },
  { id: "3", sender: "Sarah Chen", content: "Actually, yes! I'm building a semantic code search tool for my team at work. Would love to pick your brain on the embedding strategy you used.", timestamp: new Date(Date.now() - 1000 * 60 * 60 * 1), isOwn: false, avatar: null },
  { id: "4", sender: "Sarah Chen", content: "Also, I'm organizing a small hackathon next month focused on developer tools. Would you be interested in joining as a mentor or participant?", timestamp: new Date(Date.now() - 1000 * 60 * 30), isOwn: false, avatar: null },
];

export default function MessagesPage() {
  const [selectedConversation, setSelectedConversation] = useState(mockConversations[0]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showConversation, setShowConversation] = useState(true);

  return (
    <div className="container-padding section-spacing h-[calc(100vh-4rem)] flex flex-col">
      <div className="mb-6">
        <h1 className="font-display text-display-md font-bold tracking-tight">Messages</h1>
        <p className="text-muted-foreground mt-1">Your conversations with builders, teams, and projects</p>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-0">
        <div className="lg:w-96 flex flex-col border-r border-border min-w-0">
          <div className="p-4 border-b border-border flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm" className="flex-1">
                <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
                New Message
              </Button>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          <Tabs defaultValue="all" className="flex-1 flex flex-col border-r border-border" orientation="vertical">
            <TabsList className="flex flex-col border-b-0 border-r p-2" aria-label="Conversation filters">
              <TabsTrigger value="all" className="justify-start data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">All</TabsTrigger>
              <TabsTrigger value="direct" className="justify-start data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Direct Messages</TabsTrigger>
              <TabsTrigger value="groups" className="justify-start data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Groups</TabsTrigger>
              <TabsTrigger value="projects" className="justify-start data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Projects</TabsTrigger>
              <TabsTrigger value="teams" className="justify-start data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Teams</TabsTrigger>
            </TabsList>

            <TabsContent value="all" className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-2 space-y-1">
                  {mockConversations.map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conversation={conv}
                      isSelected={selectedConversation?.id === conv.id}
                      onClick={() => { setSelectedConversation(conv); setShowConversation(true); }}
                    />
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="direct" className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-2 space-y-1">
                  {mockConversations.filter(c => c.type === "DIRECT").map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conversation={conv}
                      isSelected={selectedConversation?.id === conv.id}
                      onClick={() => { setSelectedConversation(conv); setShowConversation(true); }}
                    />
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="groups" className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-2 space-y-1">
                  {mockConversations.filter(c => c.type === "GROUP").map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conversation={conv}
                      isSelected={selectedConversation?.id === conv.id}
                      onClick={() => { setSelectedConversation(conv); setShowConversation(true); }}
                    />
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="projects" className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-2 space-y-1">
                  {mockConversations.filter(c => c.type === "PROJECT").map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conversation={conv}
                      isSelected={selectedConversation?.id === conv.id}
                      onClick={() => { setSelectedConversation(conv); setShowConversation(true); }}
                    />
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent value="teams" className="flex-1 overflow-hidden">
              <ScrollArea className="h-full">
                <div className="p-2 space-y-1">
                  {mockConversations.filter(c => c.type === "TEAM").map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conversation={conv}
                      isSelected={selectedConversation?.id === conv.id}
                      onClick={() => { setSelectedConversation(conv); setShowConversation(true); }}
                    />
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          {selectedConversation ? (
            <ConversationView
              conversation={selectedConversation}
              messages={mockMessages}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <Card className="max-w-md text-center">
                <CardContent className="py-12">
                  <MessageSquare className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
                  <h3 className="text-lg font-semibold mb-2">Select a conversation</h3>
                  <p className="text-muted-foreground">Choose a conversation from the list to start messaging</p>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationItem({ conversation, isSelected, onClick }: { conversation: typeof mockConversations[0]; isSelected: boolean; onClick: () => void }) {
  const typeIcons: Record<string, React.ComponentType<{ className?: string }>> = {
    DIRECT: MessageSquare,
    GROUP: MessageSquare,
    PROJECT: MessageSquare,
    TEAM: MessageSquare,
  };
  const Icon = typeIcons[conversation.type] || MessageSquare;

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 p-3 rounded-lg transition-all text-left",
        isSelected
          ? "bg-primary/10 border border-primary/20"
          : "hover:bg-accent/50"
      )}
    >
      <div className="relative flex-shrink-0">
        <Avatar className="h-11 w-11">
          <AvatarFallback className="text-sm font-medium">{conversation.name.charAt(0)}</AvatarFallback>
        </Avatar>
        {conversation.online && (
          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-success-500 border-2 border-background" aria-label="Online" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <p className={cn("font-medium truncate", isSelected && "text-primary")}>{conversation.name}</p>
          <p className="text-xs text-muted-foreground shrink-0 ml-2">{formatDistanceToNow(conversation.timestamp, { addSuffix: true })}</p>
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-sm text-muted-foreground truncate">{conversation.lastMessage}</p>
          {conversation.unread > 0 && (
            <Badge variant="secondary" className="bg-primary text-primary-foreground text-xs ml-2 shrink-0">
              {conversation.unread}
            </Badge>
          )}
        </div>
      </div>
    </button>
  );
}

function ConversationView({ conversation, messages }: { conversation: typeof mockConversations[0]; messages: typeof mockMessages }) {
  return (
    <div className="flex flex-col h-full border-l border-border bg-background">
      <div className="flex h-16 items-center justify-between px-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10">
            <AvatarFallback className="text-sm font-medium">{conversation.name.charAt(0)}</AvatarFallback>
          </Avatar>
          <div>
            <p className="font-medium">{conversation.name}</p>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              {conversation.online && <span className="h-1.5 w-1.5 rounded-full bg-success-500" />}
              {conversation.online ? "Online" : "Offline"}
            </p>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Conversation Options</DropdownMenuLabel>
            <DropdownMenuItem>Pin Conversation</DropdownMenuItem>
            <DropdownMenuItem>Mark as Unread</DropdownMenuItem>
            <DropdownMenuItem>Mute Notifications</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive">Delete Conversation</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ScrollArea className="flex-1 p-4 space-y-4">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
      </ScrollArea>

      <MessageComposer />
    </div>
  );
}

function MessageItem({ message }: { message: typeof mockMessages[0] }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("flex gap-3", message.isOwn && "flex-row-reverse")}
    >
      {!message.isOwn && (
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarFallback className="text-xs">{message.sender.charAt(0)}</AvatarFallback>
        </Avatar>
      )}
      <div className={cn("flex-1 max-w-[70%]", message.isOwn && "text-right")}>
        {!message.isOwn && <p className="text-xs text-muted-foreground mb-1">{message.sender}</p>}
        <div
          className={cn(
            "inline-block px-4 py-2 rounded-2xl text-sm",
            message.isOwn
              ? "bg-primary text-primary-foreground rounded-tr-sm"
              : "bg-muted rounded-tl-sm"
          )}
        >
          {message.content}
        </div>
        <p className={cn("text-xs text-muted-foreground mt-1", message.isOwn ? "text-right" : "")}>
          {formatDistanceToNow(message.timestamp, { addSuffix: true })}
        </p>
      </div>
      {message.isOwn && (
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarFallback className="text-xs">You</AvatarFallback>
        </Avatar>
      )}
    </motion.div>
  );
}

function MessageComposer() {
  const [message, setMessage] = useState("");
  return (
    <div className="border-t border-border p-4 bg-background/50 backdrop-blur-sm">
      <div className="flex items-end gap-2">
        <div className="flex-1 relative">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type a message..."
            className="w-full min-h-[44px] max-h-32 px-4 py-3 pr-12 rounded-xl border border-input bg-background resize-none text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            rows={1}
          />
        </div>
        <Button
          disabled={!message.trim()}
          size="icon"
          className="h-10 w-10 rounded-xl"
          aria-label="Send message"
        >
          <MessageSquare className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}