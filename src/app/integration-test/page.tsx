"use client";

import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ProfileCard } from "@/components/ui/profile-card";
import { cn } from "@/lib/utils";

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2,
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
      duration: 0.6,
    },
  },
};

const buttonVariants = {
  initial: { scale: 1 },
  hover: { scale: 1.02 },
  tap: { scale: 0.98 },
};

export default function IntegrationTestPage() {
  const mockBuilders = [
    {
      name: "Sarah Chen",
      role: "Full Stack Engineer",
      headline: "Building AI-powered developer tools at Vercel",
      skills: ["React", "TypeScript", "Next.js", "Node.js", "PostgreSQL", "AWS"],
      compatibility: 94,
      imageSrc: "https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah",
      socials: {
        github: "https://github.com/sarahchen",
        linkedin: "https://linkedin.com/in/sarahchen",
      },
    },
    {
      name: "Alex Rivera",
      role: "ML Engineer",
      headline: "Training LLMs for code generation",
      skills: ["Python", "PyTorch", "Transformers", "MLOps", "Kubernetes"],
      compatibility: 87,
      imageSrc: "https://api.dicebear.com/7.x/avataaars/svg?seed=Alex",
      socials: {
        github: "https://github.com/alexrivera",
        twitter: "https://twitter.com/alexrivera",
      },
    },
    {
      name: "Maya Patel",
      role: "Product Designer",
      headline: "Designing developer experiences at Stripe",
      skills: ["Figma", "Design Systems", "Prototyping", "React", "Accessibility"],
      compatibility: 92,
      imageSrc: "https://api.dicebear.com/7.x/avataaars/svg?seed=Maya",
      socials: {
        github: "https://github.com/mayapatel",
        linkedin: "https://linkedin.com/in/mayapatel",
        twitter: "https://twitter.com/mayapatel",
      },
    },
  ];

  return (
    <motion.div
      className="min-h-screen bg-background"
      initial="hidden"
      animate="visible"
      variants={containerVariants}
    >
      {/* Background decorative elements */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <motion.div
          className="absolute top-20 left-10 w-96 h-96 rounded-full bg-primary/10 blur-3xl"
          animate={{ scale: [1, 1.1, 1], opacity: [0.3, 0.5, 0.3] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute bottom-20 right-10 w-96 h-96 rounded-full bg-builder-500/10 blur-3xl"
          animate={{ scale: [1, 1.05, 1], opacity: [0.2, 0.4, 0.2] }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut", delay: 2 }}
        />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
        {/* Header */}
        <motion.div
          variants={itemVariants}
          className="text-center mb-16"
        >
          <motion.span
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1, type: "spring" }}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-medium border border-primary/20"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            Integration Test: All Systems Operational
          </motion.span>
          
          <motion.h1
            variants={itemVariants}
            className="mt-6 text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-foreground"
          >
            Tool Integration <span className="text-primary">Verification</span>
          </motion.h1>
          
          <motion.p
            variants={itemVariants}
            className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto"
          >
            This page demonstrates the three core tools working together: UI/UX Pro Max design system, 21st.dev component patterns, and Motion animations.
          </motion.p>
        </motion.div>

        {/* Status Indicators */}
        <motion.div
          variants={itemVariants}
          className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12"
        >
          {[
            { name: "UI/UX Pro Max", status: "Active", color: "text-primary", bg: "bg-primary/10", icon: "🎨" },
            { name: "21st.dev", status: "Authenticated", color: "text-builder-500", bg: "bg-builder-500/10", icon: "🧩" },
            { name: "Motion v13.2", status: "Running", color: "text-success-500", bg: "bg-success-500/10", icon: "⚡" },
          ].map((tool, index) => (
            <motion.div
              key={tool.name}
              variants={itemVariants}
              className={cn("p-6 rounded-xl border border-border/50 bg-card/50 backdrop-blur-sm", tool.bg)}
            >
              <div className="flex items-center gap-3 mb-2">
                <span className="text-2xl">{tool.icon}</span>
                <h3 className="font-semibold text-foreground">{tool.name}</h3>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", tool.color.replace("text-", "bg-"))} />
                <span className={cn("text-sm font-medium", tool.color)}>{tool.status}</span>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* Profile Cards Grid - Using 21st.dev inspired component */}
        <motion.section
          variants={itemVariants}
          className="mb-16"
        >
          <motion.div
            className="flex items-center justify-between mb-8"
            variants={itemVariants}
          >
            <div>
              <h2 className="text-2xl font-bold text-foreground">Recommended Builders</h2>
              <p className="text-muted-foreground">Discovered using compatibility engine (UI/UX Pro Max pattern)</p>
            </div>
            <Button variant="ghost" size="sm">
              View All
            </Button>
          </motion.div>

          <motion.div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
            variants={containerVariants}
          >
            {mockBuilders.map((builder, index) => (
              <motion.div key={builder.name} variants={itemVariants} custom={index}>
                <ProfileCard
                  imageSrc={builder.imageSrc}
                  name={builder.name}
                  role={builder.role}
                  headline={builder.headline}
                  skills={builder.skills}
                  compatibility={builder.compatibility}
                  socials={builder.socials}
                />
              </motion.div>
            ))}
          </motion.div>
        </motion.section>

        {/* Interactive Demo Section */}
        <motion.section
          variants={itemVariants}
          className="rounded-2xl border border-border/50 bg-card/50 p-8 backdrop-blur-sm"
        >
          <h2 className="text-2xl font-bold text-foreground mb-6">Interactive Motion Demo</h2>
          <p className="text-muted-foreground mb-8">
            Hover, click, and interact with these elements to see Motion animations in action.
          </p>
          
          <div className="flex flex-wrap items-center gap-4">
            <motion.button
              whileHover={{ scale: 1.05, boxShadow: "0 10px 25px -5px hsl(var(--primary) / 0.4)" }}
              whileTap={{ scale: 0.95 }}
              className={cn("group relative px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium", "overflow-hidden")}
            >
              <span className="relative z-10">Primary Action</span>
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-primary to-builder-400 opacity-0 group-hover:opacity-100"
                transition={{ duration: 0.3 }}
              />
            </motion.button>

            <motion.button
              whileHover={{ x: 4 }}
              whileTap={{ scale: 0.95 }}
              className={cn("px-6 py-3 rounded-lg border border-border bg-background text-foreground font-medium")}
            >
              Secondary Action
            </motion.button>

            <motion.div
              className="relative h-12 w-12 rounded-lg bg-gradient-to-br from-primary to-builder-400"
              whileHover={{ rotate: 180, scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            >
              <motion.div
                className="absolute inset-0 flex items-center justify-center"
                animate={{ rotate: [0, 360] }}
                transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
              >
                <svg className="h-6 w-6 text-primary-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </motion.div>
            </motion.div>
          </div>

          {/* Stagger Animation Demo */}
          <div className="mt-10">
            <h3 className="text-lg font-medium text-foreground mb-4">Stagger List Animation (GSAP-style)</h3>
            <motion.div
              className="grid grid-cols-2 md:grid-cols-4 gap-3"
              initial="hidden"
              animate="visible"
              variants={containerVariants}
            >
              {Array.from({ length: 8 }).map((_, i) => (
                <motion.div
                  key={i}
                  variants={itemVariants}
                  className="aspect-square rounded-lg bg-gradient-to-br from-primary/10 to-builder-500/10 border border-primary/20 flex items-center justify-center font-medium text-primary"
                  style={{ transitionDelay: `${i * 50}ms` }}
                >
                  Item {i + 1}
                </motion.div>
              ))}
            </motion.div>
          </div>
        </motion.section>

        {/* Design System Tokens Display */}
        <motion.section
          variants={itemVariants}
          className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {[
            { label: "Primary", value: "#E11D48", css: "--color-primary" },
            { label: "Background", value: "#FFF1F2", css: "--color-background" },
            { label: "Card", value: "#FFFFFF", css: "--color-card" },
            { label: "Radius", value: "0.5rem", css: "--radius" },
          ].map((token) => (
            <motion.div
              key={token.label}
              variants={itemVariants}
              className="p-6 rounded-xl border border-border/50 bg-card/50"
            >
              <div className="flex items-center gap-3 mb-2">
                <div 
                  className="h-8 w-8 rounded-lg border border-border/50"
                  style={{ backgroundColor: token.value }}
                />
                <div>
                  <p className="font-medium text-foreground">{token.label}</p>
                  <p className="text-sm text-muted-foreground font-mono">{token.value}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground font-mono">{token.css}</p>
            </motion.div>
          ))}
        </motion.section>

        {/* Footer Actions */}
        <motion.div
          variants={itemVariants}
          className="mt-16 flex flex-col sm:flex-row items-center justify-center gap-4"
        >
          <Button size="lg" className="w-full sm:w-auto">
            Start Building
          </Button>
          <Button variant="outline" size="lg" className="w-full sm:w-auto">
            View Documentation
          </Button>
        </motion.div>
      </div>
    </motion.div>
  );
}