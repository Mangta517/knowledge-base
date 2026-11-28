import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { checkBuiltPages, prepareDevAssets } from './scripts/check-built-pages.mjs';

function normalizeBase(raw = '') {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : undefined;
}

function normalizeSiteUrl(raw = 'https://mangta517.github.io') {
  const candidate = String(raw || 'https://mangta517.github.io').trim().replace(/\/+$/, '');
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Invalid SITE_URL protocol: ${parsed.protocol}`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

const siteUrl = normalizeSiteUrl(process.env.SITE_URL);
const base = normalizeBase(process.env.SITE_BASE || '');
const siteRoot = new URL(`${siteUrl}${base || ''}/`);

// These synchronous scripts run before the theme, shortcut and sidebar controls paint.
const inlineScripts = [
  "'sha256-+xF0M8GFq7VkWiEItkiv4YbcP/xcmYMVKvpQwtweWD0='", // CustomThemeProvider
  "'sha256-f/zAUE74ucc3JYp4r4QQvkJofoQdkOIhHYK+jeZ6eko='", // Starlight search shortcut
  "'sha256-yiTapURQAzVYqJIJXL03Gepg/022hHZUVvS4f8isCN8='", // Starlight theme selector
  "'sha256-wX2yOADeV+NMngflD5uYi3vl50SHC4sfM1EmylVjlX4='", // Sidebar state
  "'sha256-7eCV4jtsr4t4knb3c4FCRPeu7GGZeOUGE3XvWix0XOQ='", // Sidebar scroll position
];

const productionHead = [];
if (process.env.NODE_ENV !== 'development') {
  productionHead.push({
    tag: 'meta',
    attrs: {
      'http-equiv': 'Content-Security-Policy',
      content: [
        "default-src 'self'",
        `script-src 'self' 'wasm-unsafe-eval' ${inlineScripts.join(' ')}`, // Pagefind uses WebAssembly.
        "style-src 'self' 'unsafe-inline'", // Mermaid and syntax highlighting generate styles.
        "font-src 'self' data:",
        "img-src 'self' https: data:",
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'none'",
        "frame-src 'none'",
      ].join('; '),
    },
  });
}

export default defineConfig({
  site: siteUrl,
  ...(base ? { base } : {}),
  outDir: '../../dist',
  vite: {
    build: {
      assetsInlineLimit(file) {
        if (/\.m?js$/.test(file)) {
          return false;
        }
      },
      // Mermaid splits optional ELK layout into an on-demand lazy chunk (~1.46 MB) that is never loaded on standard pages
      chunkSizeWarningLimit: 1600,
    },
  },
  markdown: {
    syntaxHighlight: {
      type: 'shiki',
      excludeLangs: ['mermaid'],
    },
  },
  integrations: [
    {
      name: 'kb-check-built-pages',
      hooks: {
        'astro:config:setup': async ({ command, config }) => {
          if (command === 'dev') {
            await prepareDevAssets(config, siteRoot);
          }
        },
        'astro:build:done': (output) => checkBuiltPages(output, siteRoot),
      },
    },
    starlight({
      title: 'Mangta 工程知识库',
      description: '基于 Mangta517 全部公开 GitHub 项目的嵌入式固件、架构决策与排障知识库。',
      disable404Route: true,
      head: [
        ...productionHead,
        {
          tag: 'meta',
          attrs: {
            name: 'referrer',
            content: 'strict-origin-when-cross-origin',
          },
        },
      ],
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
      customCss: [
        '@fontsource-variable/plus-jakarta-sans',
        '@fontsource-variable/source-sans-3',
        '@fontsource-variable/noto-sans-sc',
        '@fontsource/maple-mono/400.css',
        '@fontsource/maple-mono/400-italic.css',
        '@fontsource/maple-mono/500.css',
        '@fontsource/maple-mono/600.css',
        '@fontsource/maple-mono/700.css',
        'lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css',
        './src/styles/custom.css',
      ],
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
