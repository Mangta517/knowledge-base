import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

function normalizeBase(raw = '') {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : undefined;
}

const siteUrl = (process.env.SITE_URL || 'https://mangta517.github.io').replace(/\/+$/, '');
const base = normalizeBase(process.env.SITE_BASE || '');

export default defineConfig({
  site: siteUrl,
  ...(base ? { base } : {}),
  outDir: '../../dist',
  markdown: {
    syntaxHighlight: {
      type: 'shiki',
      excludeLangs: ['mermaid'],
    },
  },
  integrations: [
    starlight({
      title: 'Mangta 工程知识库',
      description: '基于 Mangta517 全部公开 GitHub 项目的嵌入式固件、架构决策与排障知识库。',
      disable404Route: true,
      defaultLocale: 'root',
      locales: {
        root: {
          label: '简体中文',
          lang: 'zh-CN',
        },
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/Mangta517',
        },
      ],
      customCss: ['./src/styles/custom.css'],
      components: {
        ThemeProvider: './src/components/CustomThemeProvider.astro',
        Footer: './src/components/CustomFooter.astro',
        SocialIcons: './src/components/CustomSocialIcons.astro',
        PageTitle: './src/components/CustomPageTitle.astro',
        TableOfContents: './src/components/CustomTableOfContents.astro',
      },
      sidebar: [
        {
          label: '快速导览',
          items: [
            { label: '知识库总览', link: '/' },
            { label: '知识关系图谱', link: '/graph/' },
          ],
        },
        {
          label: '项目档案',
          items: [{ autogenerate: { directory: 'projects' } }],
        },
        {
          label: '跨项目专题',
          items: [{ autogenerate: { directory: 'topics' } }],
        },
        {
          label: '架构决策 (ADR)',
          items: [{ autogenerate: { directory: 'adr' } }],
        },
        {
          label: '排障案例',
          items: [{ autogenerate: { directory: 'troubleshooting' } }],
        },
        {
          label: '跨项目复盘',
          items: [{ autogenerate: { directory: 'synthesis' } }],
        },
      ],
    }),
  ],
});
