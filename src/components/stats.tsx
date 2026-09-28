"use client";

import React from "react";
import { motion } from "framer-motion";
import { Users, Trophy, GitBranch, Zap, MessageSquare, Award } from "lucide-react";
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
  hidden: { y: 20, opacity: 0, scale: 0.9 },
  visible: {
    y: 0,
    opacity: 1,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 260,
      damping: 28,
    },
  },
};

const counterVariants = {
  initial: { opacity: 0 },
  animate: {
    opacity: 1,
    transition: {
      duration: 2,
      ease: "easeOut",
    },
  },
};

const stats = [
  { value: "12,847", label: "Active Builders", icon: "Users", color: "primary", suffix: "+" },
  { value: "342", label: "Hackathons Hosted", icon: "Trophy", color: "warning", suffix: "+" },
  { value: "8,921", label: "Projects Shipped", icon: "GitBranch", color: "success", suffix: "+" },
  { value: "2.4M", label: "Messages Exchanged", icon: "MessageSquare", color: "builder", suffix: "" },
  { value: "94%", label: "Avg Compatibility", icon: "Award", color: "primary", suffix: "" },
  { value: "24/7", label: "Real-time Support", icon: "Zap", color: "success", suffix: "" },
];

const icons: Record<string, React.ComponentType<{ className?: string }>> = {
  Users, Trophy, GitBranch, Zap, MessageSquare, Award,
};

export function Stats() {
  return (
    <section className="py-16 sm:py-20 bg-background border-y border-border/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6 sm:gap-8"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {stats.map((stat, index) => {
            const IconComponent = icons[stat.icon];
            return (
              <motion.div
                key={stat.label}
                variants={itemVariants}
                className="relative text-center p-6 rounded-2xl bg-card/50 backdrop-blur-sm border border-border/50 hover:border-primary/30 hover:shadow-lg transition-all duration-300"
                style={{ transitionDelay: `${index * 50}ms` }}
              >
                <motion.div
                  className={cn("inline-flex items-center justify-center h-12 w-12 rounded-xl mb-4 mx-auto", `bg-${stat.color}-100 text-${stat.color}-600 dark:bg-${stat.color}-900/30 dark:text-${stat.color}-400`)}
                  initial={{ scale: 0, rotate: -90 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.3 + index * 0.05, type: "spring", stiffness: 260, damping: 20 }}
                >
                  <IconComponent className="h-6 w-6" />
                </motion.div>
              
              <motion.div
                className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground font-mono tabular-nums"
                variants={counterVariants}
              >
                <span className="counter" data-target={stat.value.replace(/[^\d.]/g, '')}>
                  {stat.value}
                </span>
                <span className="text-primary">{stat.suffix}</span>
              </motion.div>
              
              <p className="text-sm font-medium text-muted-foreground mt-2">{stat.label}</p>
              
              {/* Decorative line */}
              <motion.div
                className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-0.5 bg-gradient-to-r from-primary to-builder-400 rounded-full"
                initial={{ width: 0 }}
                whileInView={{ width: "60%" }}
                viewport={{ once: true }}
                transition={{ delay: 0.5, duration: 0.5 }}
              />
            </motion.div>
          )})}
        </motion.div>
      </div>
    </section>
  );
}