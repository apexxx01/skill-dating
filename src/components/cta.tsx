"use client";

import React from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ArrowRight, Github, Users, Code, Shield } from "lucide-react";
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

const floatingVariants = {
  animate: {
    y: [0, -10, 0],
    transition: {
      duration: 4,
      repeat: Infinity,
      ease: "easeInOut",
    },
  },
};

export function CTA() {
  const benefits = [
    { icon: Users, title: "Find Your Team", desc: "AI-powered matching for hackathons & projects" },
    { icon: Code, title: "Build Together", desc: "Real-time collaboration with integrated tools" },
    { icon: Shield, title: "Build Reputation", desc: "Evidence-based XP, achievements & rankings" },
    { icon: Github, title: "Open Source Ready", desc: "Connect GitHub, verify skills, contribute" },
  ];

  return (
    <section className="py-20 sm:py-28 lg:py-32 relative overflow-hidden">
      <div className="absolute inset-0 -z-10">
        <motion.div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full bg-primary/5 blur-3xl"
          animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.1, 0.3] }}
          transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="rounded-3xl bg-gradient-to-br from-primary/95 via-primary to-builder-600 p-8 sm:p-12 lg:p-16 text-center relative overflow-hidden"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {/* Background pattern */}
          <div className="absolute inset-0 opacity-10" style={{
            backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32' fill='none' stroke='white'%3e%3cpath d='M0 .5H31.5V32'/%3e%3c/svg%3e")`,
            backgroundSize: '64px 64px',
          }} />
          
          {/* Floating decorative elements */}
          {[1, 2, 3, 4].map((i) => (
            <motion.div
              key={i}
              className="absolute rounded-full bg-white/10"
              style={{
                width: `${40 + i * 20}px`,
                height: `${40 + i * 20}px`,
                top: `${10 + i * 15}%`,
                left: `${5 + i * 20}%`,
              }}
              animate={floatingVariants}
              transition={{ delay: i * 0.5 }}
            />
          ))}
          
          {[1, 2, 3, 4].map((i) => (
            <motion.div
              key={i + 4}
              className="absolute rounded-full bg-white/10"
              style={{
                width: `${30 + i * 15}px`,
                height: `${30 + i * 15}px`,
                bottom: `${10 + i * 12}%`,
                right: `${5 + i * 18}%`,
              }}
              animate={floatingVariants}
              transition={{ delay: i * 0.5 + 1 }}
            />
          ))}

          <div className="relative max-w-4xl mx-auto">
            <motion.div
              variants={itemVariants}
              className="mb-8"
            >
              <motion.span
                className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20 text-white text-sm font-medium border border-white/30 backdrop-blur-sm"
              >
                <motion.span
                  className="relative flex h-2 w-2"
                  animate={{ scale: [1, 1.3, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                >
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white/50" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
                </motion.span>
                Now in Public Beta
              </motion.span>
            </motion.div>

            <motion.h2
              variants={itemVariants}
              className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-white mb-6"
            >
              Where Builders
              <br />
              <span className="relative">
                <span className="relative z-10">Belong</span>
                <motion.div
                  className="absolute bottom-0 left-0 right-0 h-2 bg-white/30"
                  animate={{ scaleX: [0, 1, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                />
              </span>
            </motion.h2>

            <motion.p
              variants={itemVariants}
              className="text-lg sm:text-xl text-white/80 max-w-2xl mx-auto mb-12"
            >
              Join the builder-first social network. No spam. No influencers. Just people who ship.
            </motion.p>

            <motion.div
              variants={itemVariants}
              className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16"
            >
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className={cn("group relative px-8 py-4 rounded-lg bg-white text-primary font-semibold text-lg", "overflow-hidden")}
              >
                <span className="relative z-10 flex items-center gap-2">
                  Start Building Free
                  <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
                </span>
                <motion.div
                  className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100"
                  transition={{ duration: 0.3 }}
                />
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className={cn("px-8 py-4 rounded-lg border-2 border-white/30 bg-transparent text-white font-semibold text-lg hover:bg-white/10")}
              >
                Watch Demo
              </motion.button>
            </motion.div>

            {/* Benefits Grid */}
            <motion.div
              variants={itemVariants}
              className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-12"
            >
              {benefits.map((benefit, index) => (
                <motion.div
                  key={benefit.title}
                  variants={itemVariants}
                  className="p-6 rounded-2xl bg-white/10 backdrop-blur-sm border border-white/20 text-left group"
                  whileHover={{ y: -4 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                >
                  <motion.div
                    className="h-10 w-10 rounded-xl bg-white/20 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300"
                    whileHover={{ rotate: 6 }}
                  >
                    <benefit.icon className="h-5 w-5 text-white" />
                  </motion.div>
                  <h4 className="font-semibold text-white mb-1">{benefit.title}</h4>
                  <p className="text-sm text-white/70">{benefit.desc}</p>
                </motion.div>
              ))}
            </motion.div>

            {/* Trust Signals */}
            <motion.div
              variants={itemVariants}
              className="flex flex-wrap items-center justify-center gap-8 text-white/60 text-sm"
            >
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4" />
                <span>Secure & Private</span>
              </div>
              <div className="flex items-center gap-2">
                <Github className="h-4 w-4" />
                <span>GitHub Integration</span>
              </div>
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                <span>12,847+ Builders</span>
              </div>
              <div className="flex items-center gap-2">
                <Code className="h-4 w-4" />
                <span>Open Source Friendly</span>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}