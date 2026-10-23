// What the world is made of: the cities, the colleges, the names, the kinds of builder, the skills, and the words they write. Plain data, no database and no randomness.

export interface CampusSeed {
  slug: string
  name: string
  domains: string[]
}

export interface CitySeed {
  key: string
  city: string
  cityKey: string
  country: string
  countryCode: string
  timezone: string
  /** Share of the world's people living here (weights, not percentages). */
  weight: number
  /** Which pool of names people here are given. */
  names: 'india' | 'us' | 'uk' | 'germany' | 'nigeria' | 'singapore' | 'brazil'
  campuses: CampusSeed[]
  /** Local places a hackathon can be held. */
  venues: string[]
}

export const CITIES: readonly CitySeed[] = [
  { key: 'blr', city: 'Bangalore', cityKey: 'bangalore', country: 'India', countryCode: 'IN', timezone: 'Asia/Kolkata', weight: 14, names: 'india', campuses: [{ slug: 'iisc-bangalore', name: 'Indian Institute of Science', domains: ['iisc.ac.in'] }, { slug: 'pes-university', name: 'PES University', domains: ['pes.edu'] }], venues: ['HSR Layout', 'Koramangala', 'Indiranagar'] },
  { key: 'del', city: 'Delhi', cityKey: 'delhi', country: 'India', countryCode: 'IN', timezone: 'Asia/Kolkata', weight: 9, names: 'india', campuses: [{ slug: 'iit-delhi', name: 'IIT Delhi', domains: ['iitd.ac.in'] }, { slug: 'dtu-delhi', name: 'Delhi Technological University', domains: ['dtu.ac.in'] }], venues: ['Hauz Khas', 'Connaught Place', 'Gurugram Cyber Hub'] },
  { key: 'bom', city: 'Mumbai', cityKey: 'mumbai', country: 'India', countryCode: 'IN', timezone: 'Asia/Kolkata', weight: 8, names: 'india', campuses: [{ slug: 'iit-bombay', name: 'IIT Bombay', domains: ['iitb.ac.in'] }], venues: ['Powai', 'BKC', 'Lower Parel'] },
  { key: 'hyd', city: 'Hyderabad', cityKey: 'hyderabad', country: 'India', countryCode: 'IN', timezone: 'Asia/Kolkata', weight: 7, names: 'india', campuses: [{ slug: 'iiit-hyderabad', name: 'IIIT Hyderabad', domains: ['iiit.ac.in'] }], venues: ['HITEC City', 'Gachibowli', 'T-Hub'] },
  { key: 'pnq', city: 'Pune', cityKey: 'pune', country: 'India', countryCode: 'IN', timezone: 'Asia/Kolkata', weight: 6, names: 'india', campuses: [{ slug: 'coep-pune', name: 'COEP Technological University', domains: ['coep.ac.in'] }], venues: ['Hinjewadi', 'Kothrud', 'Baner'] },
  { key: 'sfo', city: 'San Francisco', cityKey: 'san-francisco', country: 'United States', countryCode: 'US', timezone: 'America/Los_Angeles', weight: 10, names: 'us', campuses: [{ slug: 'uc-berkeley', name: 'UC Berkeley', domains: ['berkeley.edu'] }, { slug: 'stanford', name: 'Stanford University', domains: ['stanford.edu'] }], venues: ['SoMa', 'Mission District', 'Hayes Valley'] },
  { key: 'nyc', city: 'New York', cityKey: 'new-york', country: 'United States', countryCode: 'US', timezone: 'America/New_York', weight: 9, names: 'us', campuses: [{ slug: 'nyu', name: 'New York University', domains: ['nyu.edu'] }, { slug: 'columbia', name: 'Columbia University', domains: ['columbia.edu'] }], venues: ['Brooklyn', 'Flatiron', 'Lower Manhattan'] },
  { key: 'lon', city: 'London', cityKey: 'london', country: 'United Kingdom', countryCode: 'GB', timezone: 'Europe/London', weight: 9, names: 'uk', campuses: [{ slug: 'imperial-college', name: 'Imperial College London', domains: ['imperial.ac.uk'] }, { slug: 'ucl', name: 'University College London', domains: ['ucl.ac.uk'] }], venues: ['Shoreditch', 'King’s Cross', 'Canary Wharf'] },
  { key: 'ber', city: 'Berlin', cityKey: 'berlin', country: 'Germany', countryCode: 'DE', timezone: 'Europe/Berlin', weight: 7, names: 'germany', campuses: [{ slug: 'tu-berlin', name: 'Technische Universität Berlin', domains: ['tu-berlin.de'] }], venues: ['Kreuzberg', 'Mitte', 'Neukölln'] },
  { key: 'los', city: 'Lagos', cityKey: 'lagos', country: 'Nigeria', countryCode: 'NG', timezone: 'Africa/Lagos', weight: 7, names: 'nigeria', campuses: [{ slug: 'unilag', name: 'University of Lagos', domains: ['unilag.edu.ng'] }], venues: ['Yaba', 'Lekki', 'Victoria Island'] },
  { key: 'sin', city: 'Singapore', cityKey: 'singapore', country: 'Singapore', countryCode: 'SG', timezone: 'Asia/Singapore', weight: 6, names: 'singapore', campuses: [{ slug: 'nus', name: 'National University of Singapore', domains: ['nus.edu.sg'] }], venues: ['one-north', 'Marina Bay', 'Jurong'] },
  { key: 'gru', city: 'São Paulo', cityKey: 'sao-paulo', country: 'Brazil', countryCode: 'BR', timezone: 'America/Sao_Paulo', weight: 8, names: 'brazil', campuses: [{ slug: 'usp', name: 'Universidade de São Paulo', domains: ['usp.br'] }], venues: ['Vila Madalena', 'Faria Lima', 'Pinheiros'] },
] as const

type NamePool = { first: string[]; last: string[] }
export const NAME_POOLS: Record<CitySeed['names'], NamePool> = {
  india: {
    first: ['Aanya', 'Arjun', 'Diya', 'Ishaan', 'Kavya', 'Rohan', 'Meera', 'Vihaan', 'Ananya', 'Aditya', 'Saanvi', 'Karthik', 'Neha', 'Rahul', 'Priya', 'Siddharth', 'Tanvi', 'Varun', 'Riya', 'Harsh', 'Ira', 'Nikhil', 'Pooja', 'Yash', 'Shreya', 'Manav', 'Aarav', 'Devika', 'Kabir', 'Sneha', 'Rajat', 'Mahima', 'Tejas', 'Ritika', 'Omkar', 'Lakshmi'],
    last: ['Sharma', 'Iyer', 'Reddy', 'Kapoor', 'Nair', 'Gupta', 'Patel', 'Menon', 'Joshi', 'Desai', 'Banerjee', 'Rao', 'Kulkarni', 'Singh', 'Mehta', 'Chatterjee', 'Bhat', 'Verma', 'Naidu', 'Pillai', 'Shetty', 'Agarwal', 'Bose', 'Deshmukh', 'Khanna'],
  },
  us: {
    first: ['Maya', 'Ethan', 'Olivia', 'Noah', 'Zoe', 'Liam', 'Ava', 'Mateo', 'Harper', 'Jackson', 'Chloe', 'Caleb', 'Grace', 'Isaac', 'Naomi', 'Dylan', 'Sofia', 'Marcus', 'Tessa', 'Wyatt', 'Priscilla', 'Andre', 'Jenna', 'Theo', 'Imani', 'Gabriel', 'Hannah', 'Jordan', 'Camila', 'Devon'],
    last: ['Nguyen', 'Johnson', 'Martinez', 'Kim', 'Okafor', 'Brooks', 'Rivera', 'Chen', 'Patel', 'Walker', 'Cohen', 'Bennett', 'Foster', 'Reyes', 'Shah', 'Murphy', 'Hughes', 'Tanaka', 'Alvarez', 'Sullivan', 'Romero', 'Lindgren', 'Park', 'Wright'],
  },
  uk: {
    first: ['Oliver', 'Amelia', 'George', 'Isla', 'Arthur', 'Freya', 'Harry', 'Poppy', 'Jack', 'Imogen', 'Charlie', 'Edie', 'Oscar', 'Nia', 'Alfie', 'Rosie', 'Hamza', 'Aisha', 'Callum', 'Eilidh', 'Rhys', 'Zainab', 'Tom', 'Priya', 'Luca', 'Megan'],
    last: ['Smith', 'Jones', 'Taylor', 'Williams', 'Khan', 'Davies', 'Evans', 'Thomas', 'Patel', 'Roberts', 'Hughes', 'Walsh', 'Campbell', 'Ahmed', 'Wood', 'Clarke', 'Hussain', 'Murray', 'Ogunbanjo', 'Fraser'],
  },
  germany: {
    first: ['Lukas', 'Mia', 'Jonas', 'Hannah', 'Felix', 'Lena', 'Leon', 'Emilia', 'Paul', 'Clara', 'Finn', 'Sophie', 'Elias', 'Lea', 'Maximilian', 'Nele', 'Tim', 'Johanna', 'Emre', 'Aylin', 'Tobias', 'Katharina', 'Ben', 'Marie'],
    last: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Hoffmann', 'Schulz', 'Koch', 'Richter', 'Klein', 'Wolf', 'Neumann', 'Yilmaz', 'Schwarz', 'Krüger', 'Hartmann', 'Lange'],
  },
  nigeria: {
    first: ['Chinedu', 'Ngozi', 'Tunde', 'Amara', 'Emeka', 'Folake', 'Ifeanyi', 'Kemi', 'Obinna', 'Yetunde', 'Seun', 'Adaeze', 'Damilola', 'Chiamaka', 'Ibrahim', 'Zainab', 'Femi', 'Nneka', 'Segun', 'Bisola', 'Uche', 'Halima', 'Tobi', 'Efe'],
    last: ['Okafor', 'Adeyemi', 'Balogun', 'Nwosu', 'Ogunleye', 'Eze', 'Bello', 'Okonkwo', 'Adebayo', 'Ibrahim', 'Chukwu', 'Olawale', 'Abubakar', 'Onyeama', 'Afolabi', 'Danjuma', 'Okoro', 'Fashola'],
  },
  singapore: {
    first: ['Wei Jie', 'Mei Ling', 'Jun Hao', 'Priya', 'Zhi Xuan', 'Aisyah', 'Daniel', 'Rachel', 'Arjun', 'Hui Min', 'Farhan', 'Shu Ting', 'Kai Wen', 'Nur', 'Ethan', 'Jia Hui', 'Sanjay', 'Yi Ting', 'Amir', 'Clara'],
    last: ['Tan', 'Lim', 'Lee', 'Ng', 'Wong', 'Chua', 'Goh', 'Teo', 'Ong', 'Koh', 'Singh', 'Rahman', 'Subramaniam', 'Chan', 'Ho', 'Yeo', 'Pillai', 'Ismail'],
  },
  brazil: {
    first: ['Gabriel', 'Beatriz', 'Lucas', 'Juliana', 'Mateus', 'Camila', 'Rafael', 'Larissa', 'Pedro', 'Fernanda', 'Thiago', 'Isabela', 'Bruno', 'Letícia', 'Felipe', 'Amanda', 'Diego', 'Natália', 'Guilherme', 'Carolina', 'Vinícius', 'Mariana'],
    last: ['Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho', 'Almeida', 'Araújo', 'Barbosa', 'Nascimento', 'Moreira', 'Cardoso'],
  },
}

export interface SkillSeed {
  name: string
  slug: string
  category: string
}

export const SKILLS: readonly SkillSeed[] = [
  { name: 'React', slug: 'react', category: 'Frontend' },
  { name: 'Next.js', slug: 'nextjs', category: 'Frontend' },
  { name: 'Vue', slug: 'vue', category: 'Frontend' },
  { name: 'Tailwind CSS', slug: 'tailwind', category: 'Frontend' },
  { name: 'TypeScript', slug: 'typescript', category: 'Language' },
  { name: 'Python', slug: 'python', category: 'Language' },
  { name: 'Go', slug: 'go', category: 'Language' },
  { name: 'Rust', slug: 'rust', category: 'Language' },
  { name: 'Java', slug: 'java', category: 'Language' },
  { name: 'C++', slug: 'cpp', category: 'Language' },
  { name: 'Swift', slug: 'swift', category: 'Mobile' },
  { name: 'Kotlin', slug: 'kotlin', category: 'Mobile' },
  { name: 'Flutter', slug: 'flutter', category: 'Mobile' },
  { name: 'Mobile (React Native)', slug: 'react-native', category: 'Mobile' },
  { name: 'Node.js', slug: 'nodejs', category: 'Backend' },
  { name: 'Django', slug: 'django', category: 'Backend' },
  { name: 'FastAPI', slug: 'fastapi', category: 'Backend' },
  { name: 'GraphQL', slug: 'graphql', category: 'Backend' },
  { name: 'PostgreSQL', slug: 'postgresql', category: 'Database' },
  { name: 'Redis', slug: 'redis', category: 'Database' },
  { name: 'Data Engineering', slug: 'data-engineering', category: 'Data' },
  { name: 'Machine Learning', slug: 'machine-learning', category: 'AI' },
  { name: 'PyTorch', slug: 'pytorch', category: 'AI' },
  { name: 'LLM Apps', slug: 'llm-apps', category: 'AI' },
  { name: 'Computer Vision', slug: 'computer-vision', category: 'AI' },
  { name: 'DevOps', slug: 'devops', category: 'Infrastructure' },
  { name: 'Kubernetes', slug: 'kubernetes', category: 'Infrastructure' },
  { name: 'AWS', slug: 'aws', category: 'Infrastructure' },
  { name: 'Security', slug: 'security', category: 'Infrastructure' },
  { name: 'Embedded Systems', slug: 'embedded', category: 'Hardware' },
  { name: 'Robotics', slug: 'robotics', category: 'Hardware' },
  { name: 'Solidity', slug: 'solidity', category: 'Blockchain' },
  { name: 'Unity', slug: 'unity', category: 'Games' },
  { name: 'Three.js', slug: 'threejs', category: 'Games' },
  { name: 'UI/UX Design', slug: 'ui-ux-design', category: 'Design' },
  { name: 'Figma', slug: 'figma', category: 'Design' },
  { name: 'User Research', slug: 'user-research', category: 'Design' },
  { name: 'Product Management', slug: 'product-management', category: 'Product' },
  { name: 'Growth Marketing', slug: 'growth-marketing', category: 'Marketing' },
  { name: 'Copywriting', slug: 'copywriting', category: 'Marketing' },
  { name: 'SEO', slug: 'seo', category: 'Marketing' },
]

export type ArchetypeKey = 'fullstack' | 'frontend' | 'backend' | 'mobile' | 'ml' | 'data' | 'infra' | 'designer' | 'product' | 'growth' | 'web3' | 'hardware' | 'security' | 'games'

export interface ArchetypeSeed {
  key: ArchetypeKey
  role: string
  weight: number
  /** Skills they are strong in (levels 3 to 5), and ones they have touched (levels 1 to 3). */
  core: string[]
  extra: string[]
  /** The skills they look for in the people they build with. */
  seeks: string[]
  headlines: string[]
  /** What they build. */
  domains: string[]
}

export const ARCHETYPES: readonly ArchetypeSeed[] = [
  { key: 'fullstack', role: 'Full-Stack Engineer', weight: 18, core: ['react', 'nodejs', 'typescript', 'postgresql'], extra: ['nextjs', 'graphql', 'aws', 'tailwind'], seeks: ['ui-ux-design', 'growth-marketing', 'product-management'], headlines: ['Full-stack builder shipping weekend projects into real products', 'Turns a napkin sketch into a deployed app in a weekend', 'Product-minded engineer who ships fast and fixes faster'], domains: ['developer tools', 'productivity', 'marketplaces', 'education'] },
  { key: 'frontend', role: 'Frontend Engineer', weight: 9, core: ['react', 'typescript', 'tailwind', 'nextjs'], extra: ['vue', 'figma', 'threejs'], seeks: ['nodejs', 'ui-ux-design', 'product-management'], headlines: ['Frontend engineer obsessed with the first 100 milliseconds', 'I make dashboards that people actually want to open', 'Interfaces that feel fast, accessible and a little delightful'], domains: ['design tools', 'dashboards', 'creative tools'] },
  { key: 'backend', role: 'Backend Engineer', weight: 10, core: ['go', 'postgresql', 'nodejs', 'redis'], extra: ['rust', 'kubernetes', 'aws', 'graphql'], seeks: ['react', 'ui-ux-design', 'product-management'], headlines: ['Backend engineer who keeps systems up at 3am so you do not have to', 'Boring technology, interesting problems', 'APIs, queues and the quiet satisfaction of a flat latency graph'], domains: ['payments', 'infrastructure', 'APIs', 'logistics'] },
  { key: 'mobile', role: 'Mobile Engineer', weight: 7, core: ['react-native', 'swift', 'kotlin', 'flutter'], extra: ['typescript', 'figma'], seeks: ['nodejs', 'ui-ux-design', 'growth-marketing'], headlines: ['Mobile engineer, cross-platform by day, native by obsession', 'Apps that work offline on bad networks', 'Shipped more App Store rejections than most people have shipped apps'], domains: ['fintech', 'health', 'local commerce', 'social'] },
  { key: 'ml', role: 'ML Engineer', weight: 9, core: ['python', 'machine-learning', 'pytorch', 'llm-apps'], extra: ['computer-vision', 'fastapi', 'data-engineering'], seeks: ['react', 'nodejs', 'product-management'], headlines: ['ML engineer turning research papers into things that actually run', 'LLM apps with evals, not vibes', 'I read the paper so you can use the model'], domains: ['agents', 'speech', 'document understanding', 'recommendations'] },
  { key: 'data', role: 'Data Engineer', weight: 5, core: ['data-engineering', 'python', 'postgresql', 'aws'], extra: ['redis', 'kubernetes', 'machine-learning'], seeks: ['react', 'product-management'], headlines: ['Data engineer building pipelines nobody has to babysit', 'From messy CSVs to a table you can trust', 'Analytics that survive a schema change'], domains: ['analytics', 'climate data', 'open data', 'finance'] },
  { key: 'infra', role: 'Infrastructure Engineer', weight: 5, core: ['devops', 'kubernetes', 'aws', 'go'], extra: ['rust', 'security', 'postgresql'], seeks: ['react', 'product-management', 'nodejs'], headlines: ['Infra nerd, occasional Rust evangelist', 'I delete YAML for a living', 'Making deploys boring on purpose'], domains: ['platform engineering', 'observability', 'developer experience'] },
  { key: 'designer', role: 'Product Designer', weight: 8, core: ['ui-ux-design', 'figma', 'user-research'], extra: ['react', 'tailwind', 'copywriting'], seeks: ['react', 'nodejs', 'product-management'], headlines: ['Product designer who codes just enough to be dangerous', 'Most software fails on the first screen, not the tenth feature', 'Design systems, tiny details and honest empty states'], domains: ['consumer apps', 'health', 'education', 'accessibility'] },
  { key: 'product', role: 'Product Manager', weight: 5, core: ['product-management', 'user-research', 'copywriting'], extra: ['ui-ux-design', 'growth-marketing', 'postgresql'], seeks: ['react', 'nodejs', 'machine-learning'], headlines: ['PM who writes the first draft of the spec herself', 'Customer calls before roadmaps', 'Turning "what if" into a scoped weekend'], domains: ['B2B tools', 'marketplaces', 'creator economy'] },
  { key: 'growth', role: 'Growth Marketer', weight: 4, core: ['growth-marketing', 'copywriting', 'seo'], extra: ['product-management', 'postgresql'], seeks: ['react', 'nodejs', 'machine-learning'], headlines: ['Growth marketer who learned SQL to stop waiting on engineering', 'First hundred users, one honest channel at a time', 'Positioning, landing pages and cold emails that get replies'], domains: ['consumer apps', 'newsletters', 'creator tools'] },
  { key: 'web3', role: 'Blockchain Engineer', weight: 3, core: ['solidity', 'rust', 'typescript'], extra: ['security', 'go', 'react'], seeks: ['react', 'ui-ux-design', 'product-management'], headlines: ['Smart contract engineer, allergic to unaudited code', 'Payments rails that settle in seconds', 'Cryptography you can explain to a friend'], domains: ['payments', 'identity', 'public goods'] },
  { key: 'hardware', role: 'Hardware Engineer', weight: 3, core: ['embedded', 'robotics', 'cpp'], extra: ['python', 'rust'], seeks: ['react', 'machine-learning', 'ui-ux-design'], headlines: ['Embedded engineer: if it blinks, I probably wired it', 'Robots that fail loudly and recover gracefully', 'Firmware, sensors and a drawer full of dev boards'], domains: ['robotics', 'agritech', 'wearables', 'energy'] },
  { key: 'security', role: 'Security Engineer', weight: 2, core: ['security', 'python', 'go'], extra: ['devops', 'rust'], seeks: ['react', 'product-management'], headlines: ['Security engineer who breaks things politely', 'Threat models over checklists', 'Paranoid in a useful way'], domains: ['identity', 'privacy', 'infrastructure'] },
  { key: 'games', role: 'Game Developer', weight: 3, core: ['unity', 'cpp', 'threejs'], extra: ['typescript', 'figma'], seeks: ['ui-ux-design', 'copywriting', 'growth-marketing'], headlines: ['Game developer: weekend jams, forever prototypes', 'Tiny games with big feelings', 'Procedural worlds and a love of game feel'], domains: ['indie games', 'education', 'simulation'] },
]

export const BIO_OPENERS = [
  'Started building in college hackathons and never stopped.',
  'Day job in one thing, nights and weekends in another.',
  'Self-taught, shipped a few things nobody asked for, and a few things people did.',
  'Previously at a startup that did not make it; the lessons were worth it.',
  'Big believer in building in public, because accountability beats motivation.',
  'Moved cities for a job, stayed for the builder community.',
  'Mostly here to find people who finish what they start.',
  'Open source contributor on the side, always looking for a good small team.',
]

export const BIO_CLOSERS = [
  'Looking for a co-founder who disagrees with me productively.',
  'Happy to mentor, and always looking for a mentor too.',
  'If you are building something weird, I am interested.',
  'Ask me about my last failed project; it is a good story.',
  'Hackathon regular. Sleep optional.',
  'Currently heads-down on a project I will not shut up about once it works.',
  'I answer messages faster than I answer email.',
]

export interface ProjectTemplate {
  suffix: string
  pitch: string
}

export const PROJECT_NAME_PREFIXES = ['Pair', 'Focus', 'Paper', 'Chain', 'Trail', 'Spark', 'Ledger', 'Hive', 'Canvas', 'Pulse', 'Atlas', 'Beacon', 'Compass', 'Drift', 'Ember', 'Fable', 'Grove', 'Harbor', 'Kite', 'Lumen', 'Mosaic', 'Nimbus', 'Orbit', 'Prism', 'Quill', 'Relay', 'Sprout', 'Tidal', 'Vantage', 'Willow']
export const PROJECT_NAME_SUFFIXES = ['Up', 'Loop', 'Trail', 'Watch', 'Kit', 'Lab', 'Bot', 'Flow', 'Desk', 'Sync', 'Map', 'Cast', 'Base', 'Hub', 'Forge']

export const PROJECT_PITCHES = [
  'A {domain} tool that does one thing well, built in the open.',
  'We are making {domain} less painful for people who build on weekends.',
  'An opinionated {domain} app for small teams, with a free tier that is actually free.',
  'Open source {domain} toolkit with a hosted version for people who do not want to run it.',
  'A {domain} assistant that explains what it did and why.',
  'The simplest way to get started with {domain}, from zero to deployed in ten minutes.',
]

export const UPDATE_TITLES = [
  'Onboarding flow rework is live',
  'Weekly check-in reminders shipped',
  'Fixed the sync bug that ate drafts',
  'First ten testers are in',
  'Cut cold start from 4s to 900ms',
  'Added export to CSV after three people asked',
  'Moved to a queue for the slow parts',
  'Dark mode, finally',
  'Rewrote the settings page without a single modal',
  'We now have a public roadmap',
  'Benchmarks are in: p95 under 120 ms',
  'Docs for the API are up',
]

export const UPDATE_BODIES = [
  'The new flow cut time-to-first-success from four steps to two. Early testers finish it without help, which was the whole point.',
  'Reminders now go out the morning of a check-in and retry when the provider is slow. Boring, but it was the top complaint.',
  'It turned out to be a race between the autosave and the tab closing. Fixed, with a test that fails without the fix.',
  'Ten people from the community are using it daily. Their feedback is already changing the roadmap.',
  'Mostly lazy loading and a smaller dependency. I will write up what worked and what did not.',
  'Three separate people asked in a week, so it ships today. CSV first, JSON next.',
  'The slow parts no longer block the request. Users see the result as soon as it is ready.',
  'It follows your system setting and remembers your choice. I should have done it months ago.',
]

export const POST_TITLES: Record<'SHIP' | 'UPDATE' | 'DEVLOG' | 'DEMO', string[]> = {
  SHIP: ['Shipped: {name} is live', '{name} v1 is out', 'We launched {name}', 'It is real: {name} is public'],
  UPDATE: ['{name}: this week', 'Progress on {name}', 'What changed in {name}', '{name} update'],
  DEVLOG: ['Devlog: how {name} handles retries', 'Devlog: a bug I did not expect in {name}', 'Devlog: why {name} dropped a dependency', 'Devlog: the data model behind {name}'],
  DEMO: ['Demo: {name} in 60 seconds', 'Demo day: {name}', '{name}, running for real', 'Our hackathon demo: {name}'],
}

export const POST_BODIES = [
  'Took longer than I planned, shorter than I feared. The part I am proudest of is the part nobody will notice: it fails gracefully.\n\nWhat is next: a proper onboarding and a way to invite a friend.',
  'This week: fixed the three bugs that testers reported, cut the bundle by a third, and wrote the docs I kept promising.\n\nIf you want to try it, reply here and I will send you an invite.',
  'Some numbers: 38 testers, 412 sessions, 2 crashes (both fixed). The most-used feature is the one I almost cut.',
  'Built the first version in a weekend. Rebuilt the middle in a week. The lesson: ship the ugly version first and let people tell you what is ugly.',
  'Wrote down how it works under the hood, because three people asked. Short version: one queue, one table, and a lot of tests.',
  'We had 36 hours and a team of four who met on Friday. We shipped a working demo and one genuinely good idea.',
]

export const COMMENT_BODIES = [
  'This is great. How did you handle retries?',
  'Love the empty state. Small detail, big difference.',
  'We hit the same bug last month. Fix was a transaction around the write.',
  'Would use this today. Is there a waitlist?',
  'The benchmark numbers are impressive. What was the baseline?',
  'Congrats on shipping! The onboarding is smooth.',
  'Curious about the data model. Any chance of a devlog?',
  'Following. Want to try the beta.',
  'The demo made me smile. Nice work.',
  'How big is the team?',
]

export const SPARK_OPENERS = [
  'I saw your {thing} and I think we would build well together: I bring {mine}, you bring {theirs}. Up for a quick call this week?',
  'Your work on {thing} is exactly what we need for our next project. I can take {mine}; could you take {theirs}?',
  'We are both into {thing}. I would love to pair on a small weekend build and see if we click.',
  'I am looking for someone strong in {theirs} to build with. I have {mine} covered. Interested?',
]

export const HACKATHON_THEMES = ['AI for Good', 'Climate Tech', 'Fintech Rails', 'Developer Tools', 'Health & Wellbeing', 'Education', 'Open Source', 'Creator Economy', 'Civic Tech', 'Agents', 'Local Commerce', 'Accessibility']
export const HACKATHON_ORGANIZERS = ['Skill Dating Community', 'Open Builders Collective', 'DevJam', 'The Weekend Lab', 'Campus Ventures', 'Builders Guild', 'Hack Together', 'ShipIt Weekly']
export const HACKATHON_TRACKS = ['Best overall', 'Best use of AI', 'Best design', 'Most useful tool', 'Community choice', 'Best hardware hack', 'Best open source project']

export const REPORT_SCENARIOS = [
  { reason: 'SPAM', description: 'Posts the same promotional link on every thread.' },
  { reason: 'HARASSMENT', description: 'Replies to my posts with insults after I declined to join their project.' },
  { reason: 'FAKE_PROFILE', description: 'The profile photo and the work look copied from someone else.' },
  { reason: 'INAPPROPRIATE_CONTENT', description: 'A post that is not about building and is not safe for work.' },
  { reason: 'SPAM', description: 'Mass-messaging people with the same unsolicited offer.' },
] as const
