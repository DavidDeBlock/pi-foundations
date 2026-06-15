import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const ideas = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/ideas' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    tag: z.string().default('idee'),
    status: z.enum(['kladversie', 'in-uitvoering', 'klaar']).default('kladversie'),
    date: z.coerce.date(),
  }),
});

const flows = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/flows' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    sector: z.string().default('algemeen'),
    steps: z.array(z.string()).default([]),
  }),
});

const cases = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/cases' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    sector: z.string(),
    location: z.string().optional(),
    featured: z.boolean().default(false),
    date: z.coerce.date(),
  }),
});

export const collections = { ideas, flows, cases };
