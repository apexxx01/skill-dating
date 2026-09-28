"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Github, Linkedin, Twitter, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProfileCardProps {
  imageSrc: string;
  name: string;
  role: string;
  headline?: string;
  skills: string[];
  compatibility?: number;
  socials?: {
    github?: string;
    linkedin?: string;
    twitter?: string;
  };
  className?: string;
}

const fluidTransition = {
  type: "spring",
  stiffness: 260,
  damping: 28,
  mass: 1,
};

const contentContainerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.02,
    },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.1 },
  },
};

const elegantItemVariants = {
  hidden: { y: 12, opacity: 0, filter: "blur(6px)" },
  visible: {
    y: 0,
    opacity: 1,
    filter: "blur(0px)",
    transition: fluidTransition,
  },
};

const skillVariants = {
  hidden: { scale: 0.8, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: { type: "spring", stiffness: 300, damping: 25 },
  },
};

export function ProfileCard({
  imageSrc,
  name,
  role,
  headline,
  skills,
  compatibility,
  socials,
  className = "",
}: ProfileCardProps) {
  const [isHovered, setIsHovered] = React.useState(false);

  return (
    <motion.div
      className={cn("flex items-center justify-center", className)}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      <motion.div
        className={cn(
          "relative z-0 flex items-center overflow-hidden",
          "bg-card/80 text-card-foreground",
          "backdrop-blur-sm border border-border/50"
        )}
        style={{ cursor: "default" }}
        layout
        initial={{ borderRadius: "var(--radius)", width: 68, height: 68 }}
        animate={{
          width: isHovered ? "auto" : 68,
          borderRadius: "var(--radius)",
        }}
        transition={fluidTransition}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Decorative border */}
        <div className="absolute inset-0 z-20 rounded-[var(--radius)] border border-border/50 pointer-events-none" />
        
        {/* Gradient background */}
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-500 z-0",
            "bg-gradient-to-br from-muted/50 via-card/90 to-muted/50",
            isHovered ? "opacity-100" : "opacity-0"
          )}
        />

        {/* --- Avatar Wrapper --- */}
        <motion.div
          layout="position"
          className="relative z-30 h-14 w-14 shrink-0 m-1.5"
        >
          {/* Living Ambient Glow */}
          <motion.div
            className="absolute inset-0 rounded-full blur-xl bg-primary/30"
            animate={{
              scale: isHovered ? 1.6 : 0.8,
              opacity: isHovered ? 0.6 : 0,
              rotate: isHovered ? [0, 360] : 0,
            }}
            transition={{
              scale: { duration: 0.4, ease: "easeOut" },
              opacity: { duration: 0.4 },
              rotate: { duration: 20, repeat: Infinity, ease: "linear" }
            }}
          />

          {/* Avatar Image */}
          <motion.img
            src={imageSrc}
            alt={name}
            className="relative h-full w-full rounded-full object-cover border-2 border-background shadow-sm"
            animate={{ scale: isHovered ? 1 : 0.96 }}
            transition={fluidTransition}
          />

          {/* Status Dot */}
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: isHovered ? 1 : 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full bg-success-500 border-2 border-background z-40"
          />
        </motion.div>

        {/* --- Text Content --- */}
        <div className="relative z-20 overflow-hidden">
          <AnimatePresence mode="wait">
            {isHovered && (
              <motion.div
                variants={contentContainerVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="flex flex-col justify-center pl-4 pr-8 min-w-[200px] max-w-[320px]"
              >
                {/* Header Row: Name & Socials */}
                <div className="flex items-center justify-between gap-4 mb-1">
                  <motion.h3
                    variants={elegantItemVariants}
                    className="text-base font-semibold text-foreground tracking-tight whitespace-nowrap"
                  >
                    {name}
                  </motion.h3>

                  {socials && (
                    <motion.div
                      variants={elegantItemVariants}
                      className="flex items-center gap-1"
                    >
                      {socials.github && (
                        <a
                          href={socials.github}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center h-7 w-7 rounded-full bg-muted/80 text-muted-foreground hover:bg-primary hover:text-primary-foreground transition-colors"
                        >
                          <Github size={16} />
                        </a>
                      )}
                      {socials.linkedin && (
                        <a
                          href={socials.linkedin}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center h-7 w-7 rounded-full bg-muted/80 text-muted-foreground hover:bg-primary hover:text-primary-foreground transition-colors"
                        >
                          <Linkedin size={16} />
                        </a>
                      )}
                      {socials.twitter && (
                        <a
                          href={socials.twitter}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center h-7 w-7 rounded-full bg-muted/80 text-muted-foreground hover:bg-primary hover:text-primary-foreground transition-colors"
                        >
                          <Twitter size={16} />
                        </a>
                      )}
                    </motion.div>
                  )}
                </div>

                {/* Role & Compatibility */}
                <motion.div
                  variants={elegantItemVariants}
                  className="flex items-center gap-2 whitespace-nowrap mb-2"
                >
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {role}
                  </span>
                  {compatibility !== undefined && (
                    <>
                      <span className="h-0.5 w-0.5 rounded-full bg-border" />
                      <motion.span
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.2, type: "spring", stiffness: 300 }}
                        className="flex items-center gap-1 text-xs font-semibold text-primary"
                      >
                        <span className="relative">
                          <span className="absolute inset-0 bg-primary/20 rounded-full blur" />
                          {compatibility}%
                        </span>
                        <span className="text-muted-foreground">Compatibility</span>
                      </motion.span>
                    </>
                  )}
                </motion.div>

                {/* Headline */}
                {headline && (
                  <motion.p
                    variants={elegantItemVariants}
                    className="text-sm text-muted-foreground line-clamp-2"
                  >
                    {headline}
                  </motion.p>
                )}

                {/* Skills */}
                {skills.length > 0 && (
                  <motion.div
                    variants={elegantItemVariants}
                    className="flex flex-wrap gap-1.5 mt-2"
                  >
                    {skills.slice(0, 5).map((skill, index) => (
                      <motion.span
                        key={skill}
                        variants={skillVariants}
                        custom={index}
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20"
                      >
                        {skill}
                      </motion.span>
                    ))}
                    {skills.length > 5 && (
                      <motion.span
                        variants={skillVariants}
                        custom={5}
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground"
                      >
                        +{skills.length - 5} more
                      </motion.span>
                    )}
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}