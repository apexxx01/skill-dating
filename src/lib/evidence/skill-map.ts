// Which existing skills a repository's languages and topics evidence. A fixed table, pure: a tag that is not in it is ignored, and the engine only links
// skills that already exist (looked up by slug), so nothing a person or a repository says can create a skill.

export const LANGUAGE_SKILLS: Readonly<Record<string, string>> = {
  TypeScript: 'typescript',
  Python: 'python',
  Go: 'go',
  Rust: 'rust',
  Java: 'java',
  Kotlin: 'kotlin',
  Swift: 'swift',
  'C++': 'cpp',
  Solidity: 'solidity',
  Vue: 'vue',
  Dart: 'flutter',
}

export const TOPIC_SKILLS: Readonly<Record<string, string>> = {
  react: 'react',
  reactjs: 'react',
  nextjs: 'nextjs',
  'next-js': 'nextjs',
  'react-native': 'react-native',
  nodejs: 'nodejs',
  node: 'nodejs',
  express: 'nodejs',
  django: 'django',
  fastapi: 'fastapi',
  flutter: 'flutter',
  graphql: 'graphql',
  kubernetes: 'kubernetes',
  k8s: 'kubernetes',
  postgresql: 'postgresql',
  postgres: 'postgresql',
  redis: 'redis',
  tailwindcss: 'tailwind',
  tailwind: 'tailwind',
  threejs: 'threejs',
  'three-js': 'threejs',
  pytorch: 'pytorch',
  'machine-learning': 'machine-learning',
  'deep-learning': 'machine-learning',
  'computer-vision': 'computer-vision',
  llm: 'llm-apps',
  'llm-apps': 'llm-apps',
  langchain: 'llm-apps',
  aws: 'aws',
  docker: 'devops',
  devops: 'devops',
  terraform: 'devops',
  ethereum: 'solidity',
  'smart-contracts': 'solidity',
  unity: 'unity',
  unity3d: 'unity',
  robotics: 'robotics',
  ros: 'robotics',
  embedded: 'embedded',
  arduino: 'embedded',
  esp32: 'embedded',
  security: 'security',
  'data-engineering': 'data-engineering',
  'apache-spark': 'data-engineering',
  airflow: 'data-engineering',
  vue: 'vue',
  vuejs: 'vue',
  ios: 'swift',
  android: 'kotlin',
  golang: 'go',
}

/** A language counts when it is at least this share of the repository's code (GitHub's byte counts). */
export const LANGUAGE_MIN_SHARE = 0.1
/** And at most this many languages per repository. */
export const MAX_LANGUAGES = 3

/** The languages that make up a real part of the code, largest first. */
export function mainLanguages(bytes: Readonly<Record<string, number>>): string[] {
  const total = Object.values(bytes).reduce((sum, n) => sum + Math.max(0, n), 0)
  if (total === 0) return []
  return Object.entries(bytes)
    .filter(([, n]) => n / total >= LANGUAGE_MIN_SHARE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_LANGUAGES)
    .map(([name]) => name)
}

/** The skill slugs a repository's languages and topics map to, sorted, each once. Unknown tags are ignored. */
export function skillSlugsFor(input: { languages: readonly string[]; topics: readonly string[] }): string[] {
  const slugs = new Set<string>()
  for (const language of input.languages) {
    const slug = LANGUAGE_SKILLS[language]
    if (slug) slugs.add(slug)
  }
  for (const topic of input.topics) {
    const slug = TOPIC_SKILLS[topic.toLowerCase()]
    if (slug) slugs.add(slug)
  }
  return [...slugs].sort()
}
