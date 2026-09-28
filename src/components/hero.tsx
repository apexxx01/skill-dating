"use client";

import React from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ArrowRight, Github, Users, Trophy, Zap, Shield, Code, Palette } from "lucide-react";
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
    },
  },
};

const floatingVariants = {
  initial: { y: 0, rotate: 0 },
  animate: {
    y: [-10, 10, -10],
    rotate: [-2, 2, -2],
    transition: {
      duration: 6,
      repeat: Infinity,
      ease: "easeInOut",
    },
  },
};

export function Hero() {
  const features = [
    { icon: Users, label: "Team Formation", desc: "AI-powered matching" },
    { icon: Trophy, label: "Hackathons", desc: "Compete & win" },
    { icon: Zap, label: "Real-time Chat", desc: "Collaborate instantly" },
    { icon: Shield, label: "Verified Skills", desc: "Evidence-backed" },
    { icon: Code, label: "Projects", desc: "Build & ship together" },
    { icon: Palette, label: "Design Tools", desc: "UI/UX collaboration" },
  ];

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-background">
      {/* Background decorative elements */}
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <motion.div
          className="absolute top-1/4 left-1/4 w-[600px] h-[600px] rounded-full bg-primary/10 blur-3xl"
          animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.5, 0.3] }}
          transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] rounded-full bg-builder-500/10 blur-3xl"
          animate={{ scale: [1, 1.1, 1], opacity: [0.2, 0.4, 0.2] }}
          transition={{ duration: 15, repeat: Infinity, ease: "easeInOut", delay: 3 }}
        />
        <motion.div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full border border-primary/20"
          animate={{ scale: [0.8, 1.2, 0.8], opacity: [0.1, 0.05, 0.1] }}
          transition={{ duration: 20, repeat: Infinity, ease: "easeInOut", delay: 1 }}
        />
        
        {/* Grid pattern */}
        <div className="absolute inset-0 opacity-5" style={{
          backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32' fill='none' stroke='%23E11D48'%3e%3cpath d='M0 .5H31.5V32'/%3e%3c/svg%3e")`,
          backgroundSize: '64px 64px',
        }} />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 sm:py-32">
        <motion.div
          className="text-center"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {/* Badge */}
          <motion.div
            variants={itemVariants}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-medium border border-primary/20 mb-8"
          >
            <motion.span
              className="relative flex h-2 w-2"
              animate={{ scale: [1, 1.3, 1] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            >
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </motion.span>
            Builder-First Social Network
          </motion.div>

          {/* Main Headline */}
          <motion.h1
            variants={itemVariants}
            className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tighter text-foreground mb-6"
          >
            Find the Right People.
            <br />
            <span className="gradient-text">Build Together.</span>
            <br />
            <span className="text-muted-foreground font-normal">Ship Things.</span>
          </motion.h1>

          {/* Subheadline */}
          <motion.p
            variants={itemVariants}
            className="text-lg sm:text-xl text-muted-foreground max-w-3xl mx-auto mb-10"
          >
            The intersection of GitHub, Discord, Devpost & LinkedIn — but built for builders, not browsers.
            Discover complementary skills, form hackathon teams, and build your reputation through shipping.
          </motion.p>

          {/* CTA Buttons */}
          <motion.div
            variants={itemVariants}
            className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16"
          >
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className={cn("group relative px-8 py-4 rounded-lg bg-primary text-primary-foreground font-semibold text-lg", "overflow-hidden")}
            >
              <span className="relative z-10 flex items-center gap-2">
                Start Building
                <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
              </span>
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-primary to-builder-400 opacity-0 group-hover:opacity-100"
                transition={{ duration: 0.3 }}
              />
            </motion.button>

            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className={cn("px-8 py-4 rounded-lg border border-border bg-background text-foreground font-semibold text-lg")}
            >
              Explore Community
            </motion.button>
          </motion.div>

          {/* Feature Pills */}
          <motion.div
            variants={itemVariants}
            className="flex flex-wrap items-center justify-center gap-3"
          >
            {features.map((feature, index) => (
              <motion.div
                key={feature.label}
                variants={itemVariants}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-card/50 backdrop-blur-sm border border-border/50 text-sm text-muted-foreground"
                style={{ transitionDelay: `${index * 50}ms` }}
              >
                <feature.icon className="h-4 w-4 text-primary" />
                <span className="font-medium text-foreground">{feature.label}</span>
                <span className="hidden sm:inline">·</span>
                <span>{feature.desc}</span>
              </motion.div>
            ))}
          </motion.div>

          {/* Floating Demo Card */}
          <motion.div
            variants={itemVariants}
            className="mt-20 relative"
            animate={floatingVariants}
          >
            <div className="relative max-w-4xl mx-auto">
              <div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm p-6 shadow-2xl">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <div className="flex -space-x-2">
                      {["https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah", "https://api.dicebear.com/7.x/avataaars/svg?seed=Alex", "https://api.dicebear.com/7.x/avataaars/svg?seed=Maya"].map((src, i) => (
                        <motion.img
                          key={i}
                          src={src}
                          alt=""
                          className="h-10 w-10 rounded-full border-2 border-background object-cover"
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: 0.5 + i * 0.1, type: "spring" }}
                        />
                      ))}
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">Team Autonomous Research Agent</p>
                      <p className="text-sm text-muted-foreground">Building · 68% complete</p>
                    </div>
                  </div>
                  <motion.div
                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium"
                    animate={{ scale: [1, 1.05, 1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  >
                    <Zap className="h-4 w-4" />
                    Live Collaboration
                  </motion.div>
                </div>
                
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="text-muted-foreground">Overall Progress</span>
                      <span className="font-semibold text-foreground">68%</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-primary to-builder-400 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: "68%" }}
                        transition={{ duration: 1.5, delay: 0.5, type: "spring" }}
                      />
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-4">
                    {[
                      { label: "Frontend", value: "90%", color: "builder-500" },
                      { label: "Backend", value: "65%", color: "success-500" },
                      { label: "ML/Infra", value: "45%", color: "warning-500" },
                    ].map((item) => (
                      <motion.div
                        key={item.label}
                        className="p-3 rounded-lg bg-muted/50"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6, type: "spring" }}
                      >
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{item.label}</p>
                        <p className="text-2xl font-bold text-foreground">{item.value}</p>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </div>
              
              {/* Floating action buttons */}
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 flex gap-3">
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center"
                >
                  <Github className="h-6 w-6" />
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="h-12 w-12 rounded-full bg-background text-foreground border border-border shadow-lg flex items-center justify-center"
                >
                  <Users className="h-6 w-6" />
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="h-12 w-12 rounded-full bg-background text-foreground border border-border shadow-lg flex items-center justify-center"
                >
                  <Code className="h-6 w-6" />
                </motion.button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}