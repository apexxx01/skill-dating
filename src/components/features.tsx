"use client";

import React from "react";
import { motion } from "framer-motion";
import { 
  Users, Code, Trophy, Zap, Shield, Search, MessageSquare, 
  BarChart, GitBranch, Palette, Brain, Rocket,
  Target, Layers, Network, ShieldCheck
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { y: 30, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: {
      type: "spring",
      stiffness: 260,
      damping: 28,
    },
  },
};

function getIconComponent(name: string): React.ComponentType<{ className?: string }> {
  switch (name) {
    case "Target": return Target;
    case "Layers": return Layers;
    case "Network": return Network;
    case "Rocket": return Rocket;
    case "Users": return Users;
    case "ShieldCheck": return ShieldCheck;
    case "MessageSquare": return MessageSquare;
    case "GitBranch": return GitBranch;
    case "Zap": return Zap;
    case "BarChart": return BarChart;
    case "Trophy": return Trophy;
    case "Search": return Search;
    case "Code": return Code;
    case "Palette": return Palette;
    case "Brain": return Brain;
    case "Shield": return Shield;
    default: return Target;
  }
}

interface FeatureItem {
  name: string;
  desc: string;
  icon: string;
}

interface FeatureCategory {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  features: FeatureItem[];
}

const featureCategories: FeatureCategory[] = [
  {
    title: "Discovery & Matching",
    description: "Find builders with complementary skills using our AI-powered compatibility engine",
    icon: Search,
    color: "primary",
    features: [
      { name: "Builder Compatibility", desc: "94% match scores with detailed reasoning", icon: "Target" },
      { name: "AI Team Builder", desc: "Enter a hackathon, get optimal team recommendations", icon: "Brain" },
      { name: "Skill-Based Discovery", desc: "Filter by tech stack, experience, availability", icon: "Layers" },
      { name: "Complementary Matching", desc: "Not just similar skills — complementary ones", icon: "Network" },
    ],
  },
  {
    title: "Hackathons & Competition",
    description: "First-class hackathon experience with team formation, leaderboards, and submissions",
    icon: Trophy,
    color: "warning",
    features: [
      { name: "Hackathon Mode", desc: "Transform your dashboard into a competitive arena", icon: "Rocket" },
      { name: "Team Finder", desc: "Find teammates or join existing teams seamlessly", icon: "Users" },
      { name: "Live Leaderboards", desc: "Real-time rankings with anti-gaming measures", icon: "BarChart" },
      { name: "Submission Pipeline", desc: "From idea to shipped project with milestones", icon: "ShieldCheck" },
    ],
  },
  {
    title: "Collaboration & Communication",
    description: "Real-time messaging, project chat, and team coordination built for builders",
    icon: MessageSquare,
    color: "success",
    features: [
      { name: "Project Chat", desc: "Dedicated chat for every project with replies & reactions", icon: "MessageSquare" },
      { name: "Direct Messages", desc: "Real-time DMs with presence, typing, read receipts", icon: "MessageSquare" },
      { name: "Team Workspaces", desc: "Shared resources, files, and coordination tools", icon: "GitBranch" },
      { name: "Notifications", desc: "Smart notification center with preferences", icon: "Zap" },
    ],
  },
  {
    title: "Reputation & Growth",
    description: "Evidence-based reputation system that rewards shipping, not scrolling",
    icon: Shield,
    color: "builder",
    features: [
      { name: "XP System", desc: "Earn XP for meaningful actions: ship, win, contribute", icon: "BarChart" },
      { name: "Achievements", desc: "Meaningful badges: Hackathon Winner, First Ship, OSS Contributor", icon: "Trophy" },
      { name: "Weekly Quests", desc: "Structured challenges to grow your skills and network", icon: "Target" },
      { name: "Leaderboards", desc: "Multiple ranking systems: Global, Technical, Shipping, Rising", icon: "BarChart" },
    ],
  },
];

export function Features() {
  return (
    <section className="py-20 sm:py-28 lg:py-32 bg-muted/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="text-center mb-16"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.span
            variants={itemVariants}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-medium border border-primary/20 mb-6"
          >
            Core Features
          </motion.span>
          <motion.h2
            variants={itemVariants}
            className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground mb-4"
          >
            Everything Builders Need
          </motion.h2>
          <motion.p
            variants={itemVariants}
            className="text-lg text-muted-foreground max-w-2xl mx-auto"
          >
            A complete toolkit for discovery, collaboration, competition, and growth — all in one platform.
          </motion.p>
        </motion.div>

        <motion.div
          className="space-y-20"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {featureCategories.map((category, catIndex) => (
            <motion.div
              key={category.title}
              variants={itemVariants}
              className="relative"
            >
              {/* Category Header */}
              <div className="flex items-center gap-4 mb-10">
                <motion.div
                  className={cn("h-14 w-14 rounded-2xl flex items-center justify-center", `bg-${category.color}-100 text-${category.color}-600 dark:bg-${category.color}-900/30 dark:text-${category.color}-400`)}
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.2, type: "spring", stiffness: 260, damping: 20 }}
                >
                  <category.icon className="h-7 w-7" />
                </motion.div>
                <div>
                  <h3 className="text-2xl sm:text-3xl font-bold text-foreground">{category.title}</h3>
                  <p className="text-muted-foreground mt-1">{category.description}</p>
                </div>
              </div>

              {/* Feature Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {category.features.map((feature, featIndex) => {
                  const IconComponent = getIconComponent(feature.icon);
                  return (
                    <motion.div
                      key={feature.name}
                      variants={itemVariants}
                      className="group relative p-6 rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm transition-all duration-300 hover:border-primary/30 hover:shadow-lg hover:-translate-y-1"
                      style={{ transitionDelay: `${featIndex * 50}ms` }}
                    >
                      <motion.div
                        className={cn("h-10 w-10 rounded-xl flex items-center justify-center mb-4", `bg-${category.color}-100 text-${category.color}-600 dark:bg-${category.color}-900/30 dark:text-${category.color}-400`, "group-hover:scale-110 transition-transform duration-300")}
                        whileHover={{ rotate: 6 }}
                      >
                        <IconComponent className="h-5 w-5" />
                      </motion.div>
                      <h4 className="font-semibold text-foreground mb-2">{feature.name}</h4>
                      <p className="text-sm text-muted-foreground">{feature.desc}</p>
                    </motion.div>
                  );
                })}
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* CTA Section */}
        <motion.div
          className="mt-20 rounded-3xl bg-gradient-to-br from-primary via-builder-500 to-primary p-8 sm:p-12 lg:p-16 text-center"
          variants={itemVariants}
        >
          <motion.div
            className="max-w-3xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <h3 className="text-3xl sm:text-4xl font-bold text-primary-foreground mb-4">
              Ready to Build Something Amazing?
            </h3>
            <p className="text-primary-foreground/80 text-lg mb-8">
              Join thousands of builders finding teammates, winning hackathons, and shipping projects.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="xl" className="bg-primary-foreground text-primary hover:bg-primary-foreground/90 px-10 py-4">
                Get Started Free
              </Button>
              <Button variant="ghost" size="xl" className="text-primary-foreground hover:bg-primary-foreground/10 px-10 py-4 border-primary-foreground/30">
                View Demo
              </Button>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}