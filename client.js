// dsh-skill-router — Client half.
//
// Adds a 技能 tab to the conversation view ring, beside Chat / Trajectory / Approval /
// Context, listing which skills this session actually loaded.
//
// Everything here is Client-side on purpose. The seat delivers `useChat`, whose
// `legacy.nodes` is the ordered conversation the turn already holds, so this half reads
// skill calls straight out of it: no Host RPC, no projection key, no typert dependency and
// no Host half at all. That is also why the tab works with the model context untouched —
// nothing here is ever sent to the model.
//
// Shape of the data, verified against a running session rather than inferred:
//   assistant node   { kind: 'assistant', blocks: [ { kind: 'tool-call', name, arguments } ] }
//   tool-result node { kind: 'tool-result', call: { name, argsRaw: '<json string>' } }
// A tool call is a BLOCK discriminated by `kind`, not a node kind of its own, and the
// tool-result node repeats the same call — counting both would double every load.
//
// Field names in this file must stay in step with `collectSkillUsage` in host.js, which
// carries the same function so Node can unit-test it. A Client bundle cannot import from
// the Host half, so the duplication is deliberate; `test/usage.mjs` pins the Host copy and
// `test/client-half.mjs` pins this one's shape.

/**
 * How this file is loaded — and the two ways that went wrong.
 *
 * The browser fetches every Client half as ONE concatenated classic script:
 *
 *   <script src="/plugins/??a/client.js,dsh-skill-router/client.js,…">
 *
 * The bundler inserts each file's content verbatim. There is no per-file wrapper, so the
 * file itself must register:
 *
 *   1. `window.__ModuleLoader__.load({ id, factory })` — the registration call. Without it
 *      the bundle runs fine, nothing rings up, and the failure is reported as
 *      "loaded without registering <id>". `__ModuleLoader__.load` only QUEUES; the factory
 *      runs later in `create()`, which is what makes `require` available.
 *   2. Inside the factory, `factory(require)` supplies `require`, so React is reached with
 *      `require('react')` — a bare `React` global does not exist here.
 *
 * Two earlier versions of this file got one of those wrong each:
 *
 *   - a top-level `return` (v1.6.0). In a classic script that is a SyntaxError, and one such
 *     statement fails the WHOLE bundle, so every Client half went unregistered — including
 *     the HMR client that reports the failure, which is how the boot failure surfaced.
 *   - a bare top-level `module.exports` (v1.6.1). That fixes the syntax error but still never
 *     registers: the assignment populates a local `module` that nothing reads. Startup was
 *     clean and the tab silently did not exist.
 *
 * The shape below matches what every shipped Client half in this harness uses (dsh-context,
 * cost meter, skill center). `test/client-half.mjs` instruments `window.__ModuleLoader__` and
 * materializes the factory the way `create()` does, because a test that loads this file any
 * other way is testing a seam that does not exist — which is exactly how both failures got
 * past review.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-router',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    module.exports = {
      name: 'dsh-skill-router-client',
      // The Client runner activates the services a plugin declares, per plugin — it is not
      // global. Without this line `ctx.get('slots')` below returns undefined, apply returns
      // early, and the tab is never registered, with nothing but a console line to show for
      // it. dsh-context declares ["slots", "locale"] for the same reason; this half needs
      // only `slots`, because its Chinese names are a static glossary rather than a locale
      // dictionary.
      inject: ['slots'],
      apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ── skill name rendering ────────────────────────────────────────────────────
    // `name` is the match key for skill_load, the library index and the /skill command,
    // so the Chinese form below is DISPLAY ONLY: it must never travel back into a call,
    // and the English original stays visible next to it.

    const PHRASES = {
      'supply-chain': '供应链', 'best-practices': '最佳实践', 'ai-studio': 'AI Studio',
      'agent-platform': '智能体平台', 'vulnerability-scanner': '漏洞扫描器',
      'prompt-management': '提示词管理', 'model-registry': '模型注册表',
      'endpoint-management': '端点管理', 'resource-management': '资源管理',
      'cost-management': '成本管理', 'data-management': '数据管理',
      'risk-auditor': '风险审计', 'quality-audit': '质量审计', 'code-review': '代码审查',
      'test-driven': '测试驱动', 'getting-started': '入门', 'how-to': '操作指南',
      'step-by-step': '分步', 'end-to-end': '端到端', 'user-interface': '用户界面',
      'command-line': '命令行', 'open-source': '开源', 'third-party': '第三方',
      'real-time': '实时', 'machine-learning': '机器学习', 'unit-test': '单元测试',
      'integration-test': '集成测试',
    }

    const WORDS = {
      create: '创建', build: '构建', building: '构建', make: '制作', add: '添加', remove: '移除',
      delete: '删除', update: '更新', upgrade: '升级', install: '安装', setup: '搭建',
      configure: '配置', config: '配置', configuration: '配置', init: '初始化', initialize: '初始化',
      deploy: '部署', deployment: '部署', release: '发布', publish: '发布',
      migrate: '迁移', migration: '迁移', convert: '转换', transform: '转换',
      refactor: '重构', refactoring: '重构', fix: '修复', fixing: '修复',
      debug: '调试', debugging: '调试', troubleshoot: '排障', troubleshooting: '故障排查',
      optimize: '优化', optimization: '优化', improve: '改进', tune: '调优', tuning: '调优',
      scale: '扩缩容', scaling: '扩缩容', monitor: '监控', monitoring: '监控', observe: '观测',
      observability: '可观测性', instrument: '埋点', instrumentation: '埋点',
      test: '测试', testing: '测试', validate: '校验', validation: '校验', verify: '验证',
      review: '审查', audit: '审计', scan: '扫描', scanner: '扫描器',
      analyse: '分析', analyze: '分析', analysis: '分析', analyzer: '分析器', auditor: '审计',
      evaluate: '评估', evaluation: '评估', benchmark: '基准测试',
      generate: '生成', generating: '生成', write: '写作', writing: '写作',
      read: '读取', parse: '解析', render: '渲染', rendering: '渲染',
      design: '设计', designing: '设计', plan: '规划', planning: '规划', plans: '规划',
      implement: '实现', implementation: '实现', integrate: '集成', integration: '集成',
      document: '文档', documentation: '文档', docs: '文档', doc: '文档', guide: '指南',
      tutorial: '教程', example: '示例', examples: '示例', reference: '参考',
      cheatsheet: '速查表', quickstart: '快速开始', onboarding: '上手', checklist: '清单',
      workflow: '工作流', pipeline: '流水线', template: '模板', scaffold: '脚手架',
      agent: '智能体', agents: '智能体', skill: '技能', skills: '技能', tool: '工具', tools: '工具',
      app: '应用', application: '应用', service: '服务', server: '服务器', client: '客户端',
      api: 'API', sdk: 'SDK', cli: 'CLI', ui: 'UI', ux: 'UX', web: 'Web', site: '站点',
      code: '代码', coding: '编码', script: '脚本', scripts: '脚本', interface: '接口',
      library: '库', package: '包', module: '模块', component: '组件', components: '组件',
      framework: '框架', plugin: '插件', extension: '扩展', adapter: '适配器', middleware: '中间件',
      data: '数据', analytics: '分析', metric: '指标', metrics: '指标',
      database: '数据库', schema: '模式', query: '查询', index: '索引', cache: '缓存',
      storage: '存储', file: '文件', files: '文件', backup: '备份',
      security: '安全', auth: '认证', authentication: '认证', authorization: '授权',
      permission: '权限', permissions: '权限', secret: '密钥', secrets: '密钥', key: '密钥',
      token: '令牌', credential: '凭据', credentials: '凭据', certificate: '证书',
      encryption: '加密', vulnerability: '漏洞', threat: '威胁', risk: '风险',
      compliance: '合规', governance: '治理', policy: '策略',
      performance: '性能', latency: '延迟', memory: '内存', cpu: 'CPU', gpu: 'GPU',
      network: '网络', cluster: '集群', container: '容器', cloud: '云', platform: '平台',
      infrastructure: '基础设施', architecture: '架构', pattern: '模式', patterns: '模式',
      practice: '实践', practices: '实践', principle: '原则', standard: '规范', style: '风格',
      error: '错误', errors: '错误', exception: '异常', log: '日志', logs: '日志', logging: '日志',
      alert: '告警', alerts: '告警', incident: '事故', health: '健康', status: '状态',
      management: '管理', manager: '管理器', registry: '注册表', endpoint: '端点',
      request: '请求', response: '响应', route: '路由', routing: '路由', handler: '处理器',
      form: '表单', state: '状态', hook: '钩子', hooks: '钩子', event: '事件', events: '事件',
      message: '消息', queue: '队列', job: '任务', jobs: '任务', task: '任务', tasks: '任务',
      batch: '批处理', stream: '流', streaming: '流式',
      accessibility: '无障碍', responsive: '响应式', layout: '布局', theme: '主题',
      animation: '动画', icon: '图标', image: '图片', video: '视频', media: '媒体',
      chart: '图表', diagram: '图示', map: '地图',
      marketing: '营销', seo: 'SEO', ads: '广告', campaign: '投放', quality: '质量',
      content: '内容', blog: '博客', email: '邮件', social: '社交',
      research: '调研', discovery: '发现', brainstorm: '头脑风暴', brainstorming: '头脑风暴',
      interview: '访谈', meeting: '会议', report: '报告', dashboard: '看板',
      summary: '摘要', overview: '概览',
      helper: '助手', assistant: '助手', creator: '创建器', builder: '构建器',
      checker: '检查器', formatter: '格式化器', converter: '转换器', generator: '生成器',
      runner: '运行器', proxy: '代理', gateway: '网关',
      basics: '基础', introduction: '简介', advanced: '进阶', fundamentals: '基础', concepts: '概念',
      pitfalls: '陷阱', mistakes: '误区', solution: '方案', approach: '方法', strategy: '策略',
      development: '开发', completion: '完成', verification: '验证', systematic: '系统化',
      driven: '驱动', loop: '循环', dev: '开发', before: '前置', after: '后置',
    }

    const DROP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by',
      'with', 'without', 'using', 'use', 'via', 'is', 'are', 'be', 'as', 'it', 'its',
      'your', 'you', 'my', 'our', 'their', 'this', 'that', 'these', 'those', 'how', 'what', 'when'])

    // Product, company and framework names stay as they are: across this library the most
    // frequent name tokens are azure(148), google(44), dotnet(29) and java(26), and
    // translating those makes a name harder to recognise, not easier.
    const KEEP = new Set(['azure', 'google', 'aws', 'gcp', 'meta', 'microsoft', 'github', 'gitlab',
      'vercel', 'next', 'nextjs', 'react', 'vue', 'svelte', 'node', 'deno', 'bun', 'typescript',
      'ts', 'js', 'javascript', 'php', 'ruby', 'swift', 'kotlin', 'scala', 'elixir', 'expo',
      'remotion', 'figma', 'semgrep', 'codeql', 'aflpp', 'ossfuzz', 'supabase', 'firebase',
      'resend', 'cloudflare', 'huggingface', 'hf', 'openai', 'anthropic', 'claude', 'gemini',
      'llama', 'mcp', 'gke', 'aks', 'eks', 's3', 'ec2', 'rds', 'ecs', 'lambda', 'dynamodb',
      'bigquery', 'vertex', 'alloydb', 'spanner', 'keyvault', 'mgmt', 'blob', 'cosmos', 'fabric',
      'synapse', 'databricks', 'snowflake', 'kubernetes', 'helm', 'terraform', 'docker', 'pulumi',
      'ansible', 'jenkins', 'argo', 'prometheus', 'grafana', 'opentelemetry', 'otel', 'jaeger',
      'kafka', 'redis', 'postgres', 'postgresql', 'mysql', 'mongodb', 'sqlite', 'duckdb',
      'clickhouse', 'neo4j', 'elastic', 'stripe', 'twilio', 'sendgrid', 'slack', 'discord',
      'telegram', 'notion', 'jira', 'linear', 'shopify', 'wordpress', 'drupal', 'sanity',
      'contentful', 'webflow', 'framer', 'canva', 'blender', 'unity', 'unreal', 'godot', 'miro',
      'loom', 'netlify', 'render', 'railway', 'fly', 'heroku', 'digitalocean', 'linode',
      'deepseek', 'qwen', 'mistral', 'cohere', 'perplexity', 'groq', 'langchain', 'llamaindex',
      'haystack', 'autogen', 'crewai', 'dspy', 'vllm', 'ollama', 'onnx', 'tensorflow', 'pytorch',
      'torch', 'sklearn', 'pandas', 'numpy', 'scipy', 'polars', 'matplotlib', 'seaborn', 'plotly',
      'streamlit', 'gradio', 'fastapi', 'flask', 'django', 'rails', 'laravel', 'spring', 'quarkus',
      'micronaut', 'nest', 'express', 'koa', 'fastify', 'hono', 'elysia', 'trpc', 'graphql',
      'prisma', 'drizzle', 'sequelize', 'typeorm', 'kysely', 'vitest', 'jest', 'playwright',
      'cypress', 'selenium', 'puppeteer', 'mocha', 'chai', 'pytest', 'junit', 'rspec', 'phpunit',
      'eslint', 'prettier', 'biome', 'ruff', 'black', 'mypy', 'pyright', 'tsc', 'vite', 'webpack',
      'rollup', 'esbuild', 'swc', 'babel', 'turbo', 'nx', 'lerna', 'pnpm', 'npm', 'yarn', 'uv',
      'poetry', 'pip', 'conda', 'cargo', 'gradle', 'maven', 'bazel', 'cmake', 'ninja', 'meson',
      'git', 'gh', 'jj', 'python', 'py', 'rust', 'go', 'java', 'dotnet', 'net', 'csharp'])

    function renderZh(name) {
      const tokens = String(name || '')
        .split(/[-_./]+/)
        .filter((t) => t !== '' && !DROP.has(t.toLowerCase()))
      const out = []
      let changed = false
      let i = 0
      while (i < tokens.length) {
        const token = tokens[i]
        const lower = token.toLowerCase()
        if (KEEP.has(lower)) {
          out.push(token)
          i += 1
          continue
        }
        let matched = false
        for (let span = 3; span >= 2; span -= 1) {
          if (i + span > tokens.length) continue
          const phrase = tokens.slice(i, i + span).join('-').toLowerCase()
          if (PHRASES[phrase] !== undefined) {
            out.push(PHRASES[phrase])
            changed = true
            i += span
            matched = true
            break
          }
        }
        if (matched) continue
        const word = WORDS[lower]
        if (word !== undefined) {
          out.push(word)
          changed = true
        } else {
          out.push(token)
        }
        i += 1
      }
      return changed ? out.join('·') : ''
    }

    // ── reading the conversation ────────────────────────────────────────────────
    const LOAD_TOOLS = { skill: true, skill_load: true, skill_ref: true }
    const MAX_NAMES = 8

    /**
     * Drop trailing forward slashes without a regular expression.
     *
     * The Host copy of this function carried `.replace(/\/+$/, '')` and CodeQL flagged it as
     * polynomial (js/polynomial-redos) — measurably: 64,000 slashes took ~2,000 ms against
     * ~0 ms for this loop. The same expression sat here, in the copy, because a Client bundle
     * cannot import from the Host half. CodeQL only reads the analysed source, so it never saw
     * this one; the duplication is exactly why the fix had to be applied twice.
     */
    function stripTrailingSlashes(text) {
      let end = text.length
      while (end > 0 && text.charCodeAt(end - 1) === 47) end -= 1
      return end === text.length ? text : text.slice(0, end)
    }

    function normName(value) {
      let text = stripTrailingSlashes(String(value === null || value === undefined ? '' : value).trim().replace(/\\/g, '/'))
      // Anchored single-character and fixed alternatives: neither can backtrack.
      text = text.replace(/^@/, '').replace(/\/SKILL\.md$/i, '')
      const parts = text.split('/')
      return String(parts[parts.length - 1] || '').trim()
    }

    function splitNames(value) {
      const out = []
      const push = (entry) => {
        const text = String(entry === null || entry === undefined ? '' : entry).trim()
        if (text !== '' && out.indexOf(text) < 0) out.push(text)
      }
      const visit = (entry) => {
        if (Array.isArray(entry)) {
          for (let i = 0; i < entry.length; i += 1) visit(entry[i])
          return
        }
        if (entry === null || entry === undefined) return
        const text = String(entry).trim()
        if (text === '') return
        if (text.charAt(0) === '[' && text.charAt(text.length - 1) === ']') {
          try {
            const parsed = JSON.parse(text)
            if (Array.isArray(parsed)) {
              visit(parsed)
              return
            }
          } catch (error) {
            /* not JSON: treat it as one literal name */
          }
        }
        if (/[,;\n]/.test(text)) {
          const parts = text.split(/[,;\n]+/)
          for (let i = 0; i < parts.length; i += 1) push(parts[i])
          return
        }
        push(text)
      }
      visit(value)
      return out
    }

    function argsOf(block) {
      const raw = block === null || typeof block !== 'object' ? undefined : block.arguments
      if (raw !== null && typeof raw === 'object' && Array.isArray(raw) === false) return raw
      if (typeof raw === 'string' && raw.trim().charAt(0) === '{') {
        try {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false) return parsed
        } catch (error) {
          /* not JSON */
        }
      }
      return undefined
    }

    /** Same contract as collectSkillUsage in host.js — see the note at the top of the file. */
    function collectSkillUsage(nodes) {
      const out = []
      if (Array.isArray(nodes) === false) return out
      for (let n = 0; n < nodes.length; n += 1) {
        const node = nodes[n]
        if (node === null || typeof node !== 'object' || Array.isArray(node)) continue
        if (String(node.kind) !== 'assistant') continue
        const blocks = Array.isArray(node.blocks) ? node.blocks : []
        for (let b = 0; b < blocks.length; b += 1) {
          const block = blocks[b]
          if (block === null || typeof block !== 'object') continue
          if (String(block.kind) !== 'tool-call') continue
          const tool = String(block.name === null || block.name === undefined ? '' : block.name)
          if (LOAD_TOOLS[tool] !== true) continue
          const args = argsOf(block)
          if (args === undefined) continue
          const names = tool === 'skill_load' ? splitNames(args.name).concat(splitNames(args.names)) : splitNames(args.name)
          const seen = []
          for (let i = 0; i < names.length; i += 1) {
            const name = normName(names[i])
            if (name === '' || seen.indexOf(name) >= 0) continue
            seen.push(name)
            out.push({ name, tool })
            if (seen.length >= MAX_NAMES) break
          }
        }
      }
      return out
    }

    // ── the tab ─────────────────────────────────────────────────────────────────
    const CSS = [
      '.sr-usage{padding:12px 16px;font-size:12px;line-height:1.7;overflow:auto;height:100%}',
      '.sr-usage h3{margin:0 0 8px;font-size:13px;font-weight:600}',
      '.sr-usage-sum{margin:0 0 12px;opacity:.75}',
      '.sr-usage-row{display:flex;gap:10px;padding:3px 0;align-items:baseline;border-bottom:1px solid rgba(127,127,127,.12)}',
      '.sr-usage-idx{min-width:22px;opacity:.5;font-variant-numeric:tabular-nums}',
      '.sr-usage-zh{min-width:210px}',
      '.sr-usage-en{opacity:.55;font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:11px}',
      '.sr-usage-tool{opacity:.5;font-size:11px;margin-left:auto}',
      '.sr-usage-empty{opacity:.75}',
      '.sr-usage-note{margin-top:14px;opacity:.6;font-size:11px}',
    ].join('\n')

    // A Client bundle has no styles.insert (that is a dynamic-sandbox builtin), so the
    // stylesheet is inserted the ordinary way and removed when the plugin unloads.
    //
    // The guard is not defensive padding. `apply()` runs as soon as the bundle is evaluated,
    // and an unguarded `document.head.appendChild` throws a TypeError whenever the script is
    // evaluated before <head> exists — a classic-script tag inside <head> itself, an iframe, a
    // shadow root, or any harness that evaluates client halves without a document. Verified by
    // running apply() with `head: null`: it threw, an uncaught exception in apply() means the
    // slot registration below never runs, and the tab silently does not exist. A stylesheet is
    // cosmetic; losing the whole tab over it is not a trade worth making.
    ctx.effect(
      () => {
        const doc = typeof document === 'undefined' ? undefined : document
        if (doc === undefined || typeof doc.createElement !== 'function') return () => {}
        // `head` can be null while the parser is still inside <head>; documentElement or body
        // accept the same child and keep the styles applied.
        const host = doc.head !== null && doc.head !== undefined ? doc.head : doc.documentElement !== null && doc.documentElement !== undefined ? doc.documentElement : doc.body
        if (host === null || host === undefined || typeof host.appendChild !== 'function') return () => {}
        const tag = doc.createElement('style')
        tag.setAttribute('data-dsh-skill-router', 'usage-tab')
        tag.textContent = CSS
        host.appendChild(tag)
        return () => {
          if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag)
        }
      },
      'skill-router: usage tab styles',
    )

    function UsageView(props) {
      const useChat = props === null || props === undefined ? undefined : props.useChat
      // Called unconditionally: hooks may not sit behind a conditional return.
      const slice = typeof useChat === 'function' ? useChat((s) => (s !== null && typeof s === 'object' ? s.legacy : undefined)) : undefined
      const nodes = slice !== null && typeof slice === 'object' && Array.isArray(slice.nodes) ? slice.nodes : []
      const skills = collectSkillUsage(nodes)

      if (typeof useChat !== 'function') {
        return React.createElement('div', { className: 'sr-usage' }, React.createElement('p', { className: 'sr-usage-empty' }, '本会话没有可用的对话数据（useChat 座位缺席）。'))
      }

      const titles = []
      for (let i = 0; i < skills.length; i += 1) {
        const zh = renderZh(skills[i].name)
        titles.push((i + 1) + '. ' + (zh === '' ? skills[i].name : zh + '  (' + skills[i].name + ')'))
      }
      const head = skills.length === 0
        ? React.createElement('p', { className: 'sr-usage-sum' }, '本会话尚未加载任何技能。')
        : React.createElement('p', { className: 'sr-usage-sum' }, '共 ' + skills.length + ' 次技能加载，涉及 ' + new Set(skills.map((s) => s.name)).size + ' 个技能。')

      const rows = []
      for (let i = 0; i < skills.length; i += 1) {
        const skill = skills[i]
        const zh = renderZh(skill.name)
        rows.push(
          React.createElement(
            'div',
            { className: 'sr-usage-row', key: String(i) + '-' + skill.name },
            React.createElement('span', { className: 'sr-usage-idx' }, String(i + 1)),
            React.createElement('span', { className: 'sr-usage-zh' }, zh === '' ? '—' : zh),
            React.createElement('span', { className: 'sr-usage-en' }, skill.name),
            React.createElement('span', { className: 'sr-usage-tool' }, skill.tool),
          ),
        )
      }

      return React.createElement(
        'div',
        { className: 'sr-usage' },
        React.createElement('h3', null, '技能调用清单'),
        head,
        rows.length === 0 ? null : React.createElement('div', null, rows),
        React.createElement(
          'p',
          { className: 'sr-usage-note' },
          '中文名仅用于显示。技能名是 skill_load、索引检索与 /skill 命令的匹配键，实际调用的始终是右侧英文原名；检索仍走英文原文，SKILL.md 未被修改。',
        ),
      )
    }

    ctx.effect(
      () =>
        slots.inject('conversation.view', () =>
          slots.register(
            {
              name: 'conversation.view',
              id: 'skill-router-usage',
              // After Chat (0) and Trajectory, before nothing that matters; dsh-context
              // uses 20 for its Context tab, so 21 keeps the two neighbours stable.
              order: 21,
              label: '技能',
            },
            UsageView,
          ),
        ),
      'skill-router: usage tab',
    )
  },
}
    return module.exports
  },
})
