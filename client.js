// dsh-skill-router — Client half.
//
// Adds a 技能 tab to the conversation view ring, beside Chat / Trajectory / Approval /
// Context, listing which skills this session actually loaded.
//
// Everything here is Client-side on purpose: no Host RPC, no projection key, no typert
// dependency, no Host half at all. Nothing here is ever sent to the model.
//
// ── where the data comes from, and the three contracts that were wrong before ─────────
//
// The one authoritative source is the session ledger:
//
//   const binding = ctx.sessions.binding(props.sessionId)
//   binding.eventSource   →  ObservableSnapshot<SessionEventWindow>
//                            { entries, hasMore, revision, subscribe }
//
// It is the same stream the agent runs on, so a skill call is visible here at the moment it
// happens, with no projection of its own. Three earlier versions of this tab read something
// else, and each failure is worth keeping written down because all three looked reasonable:
//
//   1. `useChat((s) => s.legacy.nodes)` — a plausible seat, wrong data contract. Verified by
//      snapshotting it live mid-session: 210 nodes holding ZERO tool calls while the ledger
//      held 2,778+ events including the skill calls. `legacy.nodes` is a truncated UI
//      projection, not the conversation history.
//   2. Per-turn tool DECLARATIONS read out of request headers — counted skills that were
//      merely *offered* to the model as though they had been loaded. Every count it produced
//      was inflated; a session reported as "skill_load × 23" had loaded nothing of the sort.
//   3. A host-side recorder fed by an assumed Host→Client push. Measured instead of assumed:
//      the Host half's `ctx.get('remote')` is `undefined`, so that push does not exist. The
//      ledger needs no recorder — it already carries both history and the live tail.
//
// Event shape, observed rather than inferred:
//
//   { type: 'tool/call', seq, time, data: { turn, step, callId, name, arguments } }
//
// A real skill call was found at seq=6228 as `skill_search`, and `entries`/`revision` were
// watched growing while a session ran. Two properties of that window decide the design of
// the ledger below:
//
//   • `hasMore` is TRUE on the newest page. Page 0 is therefore the *recent* end of the
//     history, so a skill loaded five pages back is invisible until `loadOlder()` gets there,
//     and any count is partial until `hasMore` becomes false.
//   • The window is bounded — observed capped between ~1,664 and ~1,900 entries, and seen
//     resetting from 3,336 down to 1,664. Entries can therefore fall OUT of the window after
//     having been read. So the ledger accumulates what it has read instead of re-deriving the
//     list from the window on every render, and it merges by `callId`.
//
// `callId` is the identity of a call, not `seq` and not the array position: the same call is
// re-delivered on every later snapshot, so anything else would count one load many times.
// One call may name several skills (`name` or `names`), and the display row is
// `callId + normalized skill name`, so `A+B` yields two rows but one call.
//
// `test/usage-ledger.mjs` pins all of this against the real shapes, and loads this file the
// way the browser does (see below) rather than importing it.

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
      // it. dsh-context declares ["slots", "locale"] for the same reason. `sessions` is
      // declared because the ledger lives there and a missing one is a hard dependency: with
      // it absent the tab has nothing to read and must not pretend otherwise.
      inject: ['slots', 'sessions'],
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

    // ── the ledger ──────────────────────────────────────────────────────────────
    // Tools that actually LOAD a skill. `skill_search` is deliberately absent: searching is
    // how a skill is found, not how it is used, and counting it made every count wrong — see
    // contract (2) at the top of this file. These three are also exactly the tools this
    // plugin registers, so the tab and the router agree on what "a load" means.
    const LOAD_TOOLS = { skill: true, skill_load: true, skill_ref: true }
    // The router accepts at most 8 names per call; a 9th can never have been honoured.
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

    /**
     * The match key, from whatever the model passed.
     *
     * `skill_load` accepts a bare name, a `repo/name` pair, a full path to a SKILL.md file or
     * an `@scope/name` — and the tab must show the same skill for all of them, or the count of
     * unique skills breaks. The last path segment is that common denominator, which is also
     * what `normName` does in host.js.
     */
    function normalizeSkillName(value) {
      let text = String(value === null || value === undefined ? '' : value).trim().replace(/\\/g, '/')
      text = stripTrailingSlashes(text)
      text = text.replace(/^@/, '').replace(/\/SKILL\.md$/i, '')
      const parts = text.split('/')
      return String(parts[parts.length - 1] || '').trim()
    }

    /**
     * Every name a call can carry, as a plain array.
     *
     * `skill_load` takes `name` OR `names`, and `names` arrives either as a real array or as
     * one JSON string — both were seen in the wild. Without this the single `A+B` call form
     * would collapse into one nonsense name like `["a","b"]` and lose a skill from the count.
     */
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
        if (text.indexOf(',') >= 0 || text.indexOf(';') >= 0 || text.indexOf('\n') >= 0) {
          const parts = text.split(/[,;\n]+/)
          for (let i = 0; i < parts.length; i += 1) push(parts[i])
          return
        }
        push(text)
      }
      visit(value)
      return out
    }

    /** `arguments` may be an object or the raw JSON string the model produced. */
    function argsOf(raw) {
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

    // Test seam. The ledger is the part of this half that can be wrong while still looking
    // fine — a miscount renders a plausible list — so `test/usage-ledger.mjs` pins it: the test
    // calls this `apply` with a stub ctx and then reads these. Placed here because every value
    // above is initialized by now and nothing can have returned yet; every side effect of
    // `apply` lives inside `ctx.effect`, so an offline call registers nothing at all. The React
    // loader ignores unknown exports.
    module.exports.__internals = { buildLedger, normalizeSkillName, splitNames, argsOf, LOAD_TOOLS, MAX_NAMES }

    /**
     * Fold one window of events into the running ledger.
     *
     * Pure and total: it never throws and never mutates its inputs, because it runs on every
     * snapshot including ones taken while streaming, and a throw here would take the tab down
     * with it.
     *
     * `previous` is what makes the bounded window safe. A later snapshot re-contains the events
     * already read, and may also have LOST entries off the old end; merging by
     * `callId + normalized name` means a re-delivered call contributes nothing new while an
     * evicted one stays counted.
     */
    function buildLedger(source, options) {
      const opts = options === null || typeof options !== 'object' ? {} : options
      const files = []
      // Rows are keyed by `callId::skill`; calls by `callId` alone. Two maps, because they
      // answer different questions and dedupe differently: a call that names A and B is one
      // call and two rows, and re-reading a page must add neither.
      const seen = {}
      const counted = {}
      let calls = 0

      const take = (record) => {
        if (seen[record.id] === true) return false
        seen[record.id] = true
        files.push(record)
        if (counted[record.callId] !== true) {
          counted[record.callId] = true
          calls += 1
        }
        return true
      }
      // The prior files are replayed rather than added: `take` rebuilds both keys from the
      // records themselves, so a call carried over from an earlier page cannot be counted a
      // second time when the window re-delivers it. (Carrying the old call COUNT forward and
      // adding to it cannot work — a later page legitimately overlaps calls already counted,
      // and only the keys can tell which.)
      if (opts.previous !== null && typeof opts.previous === 'object' && Array.isArray(opts.previous.files)) {
        for (let i = 0; i < opts.previous.files.length; i += 1) take(opts.previous.files[i])
      }

      const entries = Array.isArray(source) ? source : []
      for (let i = 0; i < entries.length; i += 1) {
        const wrapper = entries[i]
        if (wrapper === null || typeof wrapper !== 'object') continue
        const event = wrapper.event !== null && typeof wrapper.event === 'object' ? wrapper.event : wrapper
        if (String(event.type) !== 'tool/call') continue
        const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
        if (data === undefined) continue
        const callId = String(data.callId === null || data.callId === undefined ? '' : data.callId)
        if (callId === '') continue
        const tool = String(data.name === null || data.name === undefined ? '' : data.name)
        if (LOAD_TOOLS[tool] !== true) continue
        const args = argsOf(data.arguments)
        if (args === undefined) continue
        const raw = tool === 'skill_load' ? splitNames(args.name).concat(splitNames(args.names)) : splitNames(args.name)
        let kept = 0
        for (let n = 0; n < raw.length && kept < MAX_NAMES; n += 1) {
          const skill = normalizeSkillName(raw[n])
          if (skill === '') continue
          kept += 1
          // `take` counts the call on the first row it accepts, so a call naming nothing
          // usable stays uncounted and a re-delivered call stays counted once.
          take({ id: callId + '::' + skill, callId, skill, tool, turn: data.turn, step: data.step })
        }
      }

      // `hasMore` is true on the newest page, so "complete" cannot be assumed from a full
      // window — it is only ever reached by paging to the start.
      //
      // `stalled` must NOT be folded into `hasMore: false` on the way in: doing that once made a
      // session whose paging had given up report "the numbers above are complete", which is the
      // one lie this tab exists to avoid. Giving up on the rest of the history and having read
      // all of it are different facts, and this is where they are kept apart.
      let completeness = 'complete'
      if (opts.error !== undefined && opts.error !== null) completeness = 'error'
      else if (opts.loading === true) completeness = 'loading'
      else if (opts.hasMore === true || opts.stalled === true) completeness = 'partial'

      // Distinct NORMALIZED names, which is the question "涉及多少个技能" asks. It dedupes
      // separately from `calls` on purpose: one call naming A and B is 1 call and 2 skills,
      // and two calls both naming A are 2 calls and 1 skill.
      const unique = {}
      let uniqueSkills = 0
      for (let i = 0; i < files.length; i += 1) {
        if (unique[files[i].skill] !== true) {
          unique[files[i].skill] = true
          uniqueSkills += 1
        }
      }

      return {
        files,
        calls,
        uniqueSkills,
        completeness,
        hasMore: opts.hasMore === true,
        page: typeof opts.page === 'number' ? opts.page : 0,
        error: opts.error === undefined ? null : opts.error,
      }
    }

    // ── reading the ledger ──────────────────────────────────────────────────────
    /**
     * Paging policy. `hasMore` is true on the newest page, so:
     *
     *   • page 0 is read immediately — that is the recent end, and waiting for it would leave
     *     the tab blank during the very work it is meant to show;
     *   • every later page is pulled exactly ONCE, in an effect, and a page is only requested
     *     while `historyComplete` is false.
     *
     * That second rule is the whole reason this is an effect and not part of render: a
     * `loadOlder()` call issued during render would re-enter render as soon as it resolved,
     * each pass asking for one more page, forever. `test/usage-ledger.mjs` pins the bound with
     * a fake source that counts `loadOlder` calls.
     */
    const LOAD_OLDER_CAP = 200
    // How long one page request may take before it is treated as no answer at all. Four seconds,
    // not eight: while this is pending the tab says "正在读取更早的记录…", and a watchdog generous
    // enough to outlast a reader's patience turns every check of "did the fix land?" into a coin
    // flip. Debugging this fix over chat made that concrete — two reports in a row were taken
    // inside the old window and looked exactly like the bug they were verifying.
    const LOAD_OLDER_TIMEOUT_MS = 4000
    // How many consecutive requests that change nothing before paging gives up for good.
    //
    // This is the fix for the live stall, and the reason is worth keeping: the real
    // `SessionController.loadOlder()` is not a request that hangs, it is a request that SILENTLY
    // DOES NOTHING on several conditions —
    //
    //   async loadOlder() {
    //     if (this.openState !== 'open' || !this.hasMore || this.loadingOlder) return  // ← three
    //     const events = this.events
    //     if (events === undefined) return                                            // ← and a fourth
    //     ...
    //
    // — and "resolved" therefore does not mean "a page arrived". A session still opening makes
    // the tab's very first call a no-op that resolves instantly. Counting that as a page read
    // left `page` and `loading` showing "still reading" forever, with a row already on screen:
    // exactly the state observed live.
    //
    // So the measurement is the WINDOW, not the promise: the shipped tab does the same thing —
    // it snapshots before and after, and treats "unchanged" as "nothing older to read"
    // (`await session.loadOlder(); return trajectory.getSnapshot() !== before`). One no-op is
    // not enough to conclude that, though: the session may simply still be opening, so a retry
    // follows, and only a run of no-ops ends the paging.
    const LOAD_OLDER_NO_PROGRESS_LIMIT = 2
    // One `tool/call` per snapshot in the best case, but streaming fragments arrive per chunk
    // — ~1,447 of 2,778 observed callbacks were `assistant/live-chunk`. Rendering per fragment
    // would spend the tab's budget on redraws of unchanged data; 400 ms is below the threshold
    // where a new row reads as missing while never redrawing mid-token.
    const LIVE_THROTTLE_MS = 400

    /** Narrow one snapshot into the few fields the ledger needs, tolerating an absent one. */
    function windowOf(source) {
      if (source === null || typeof source !== 'object') return { entries: [], hasMore: false }
      const entries = Array.isArray(source.entries) ? source.entries : []
      return { entries, hasMore: source.hasMore === true }
    }

    /**
     * Merge the current window into what has already been read.
     *
     * `base` is the seed — the page-0 read captured when the hook first ran — and the window is
     * merged on top of it, so entries that fell out of the window stay in the ledger.
     */
    function ledgerFrom(base, source, state) {
      const now = windowOf(source)
      return buildLedger(now.entries, {
        previous: base,
        hasMore: now.hasMore,
        // Passed through, NOT merged into `hasMore`: `buildLedger` must still be able to tell
        // "paging gave up here" from "the history ended here". Merging them once made a stalled
        // session print a complete-looking total.
        stalled: state.stalled === true,
        loading: state.loading,
        error: state.error,
        page: state.page,
      })
    }

    /**
     * The tab's reader: subscribe to the ledger, page backwards, stay bounded.
     *
     * Returns `{ ledger, loading, page, error }`. `ledger` carries `files` (one row per
     * callId+skill), `calls` (callIds), `uniqueSkills` (distinct names) and `completeness`.
     */
    function useUsageLedger(props) {
      const input = props === null || props === undefined ? {} : props
      // The source arrives as a PROP, bound per session by the slot registration above. That is
      // not a stylistic choice, it is the contract: `conversation.view` is declared `scope:
      // "session"`, the renderer calls a registration's `inject(sessionId)` with `binding.key`
      // and spreads the result over the component's props, and it hands the component a `binding`
      // prop as well. Reading a session out of ambient state instead would be reading something
      // the contract does not promise — and an earlier version of this file did exactly that with
      // `props.sessionId`, which is only ever populated because the conversation root happens to
      // pass it down.
      const source = input.source
      const usable = source !== null && source !== undefined && typeof source.getSnapshot === 'function'
      const absent = typeof input.sourceError === 'string' && input.sourceError !== '' ? input.sourceError : '这个会话没有可用的 eventSource。'

      const seedRef = React.useRef(null)
      if (seedRef.current === null) {
        const first = usable ? windowOf(source.getSnapshot()) : { entries: [], hasMore: false }
        seedRef.current = buildLedger(first.entries, { hasMore: first.hasMore })
      }
      const pageRef = React.useRef(0)
      const inFlightRef = React.useRef(false)
      // Set when paging gave up (a run of no-ops, a timeout, or the cap). It stops the paging
      // effect from ever re-arming, so a ledger whose `hasMore` never clears cannot spin in the
      // background for the life of the tab — the tab settles on "partial" and says so instead.
      const gaveUpRef = React.useRef(false)
      /** Largest window length observed, so "did the read move anything" survives across retries. */
      const seenRef = React.useRef(0)
      /**
       * The paging watchdog's handle, held OUTSIDE the effect that starts it.
       *
       * This is the fix for the stall observed live with v1.6.9 on screen: the tab printed its
       * version and sat on "读取中" forever, with the watchdog never firing. The mechanism is
       * re-entrancy. When the effect re-ran, React ran its cleanup, which set the attempt's local
       * `live = false`; from then on the pending watchdog callback returned immediately at its
       * `if (live === false)` guard, while `inFlightRef` stayed true so the new run exited at its
       * own guard. The result is an attempt that nothing can finish and no timer that can expire —
       * the one state this tab was built never to enter.
       *
       * So the lifetime of an attempt is no longer tied to the effect that starts it: the handle
       * lives here, and only a real unmount cancels it. A re-entered effect that finds an attempt
       * in flight simply leaves it alone — which is already what its guards do.
       *
       * `test/usage-tab.mjs` reproduces the original stall by re-rendering the view with a brand-new
       * props object each time; before this change it sat on "读取中" with `loadOlder` called once.
       */
      const watchdogRef = React.useRef(undefined)
      const unmountedRef = React.useRef(false)
      React.useEffect(
        () => () => {
          unmountedRef.current = true
          if (watchdogRef.current !== undefined) {
            clearTimeout(watchdogRef.current)
            watchdogRef.current = undefined
          }
        },
        [],
      )
      const [state, setState] = React.useState({ page: 0, loading: usable, stalled: false, timedOut: false, error: usable ? null : absent, tick: 0 })

      // One long-lived reader. `push` is stable on purpose: an effect that re-subscribed on
      // every snapshot would detach and reattach the observable on each new event, and the
      // subscription this tab needs is exactly the one that must stay put while events arrive.
      const push = React.useCallback(() => {
        if (usable === false) return
        const now = windowOf(source.getSnapshot())
        seedRef.current = buildLedger(now.entries, { previous: seedRef.current, hasMore: now.hasMore })
        // `loading` is deliberately NOT touched here. The paging effect depends on it, so a
        // writer on this side re-triggers that effect and pulls an extra page per event — the
        // symptom was 399 `loadOlder` calls against a cap of 200, and it only shows up on a
        // ledger whose history never ends. Only the paging effect and `loadOlder`'s own
        // resolution may write `loading`; this callback only says "the window moved".
        setState((prev) => ({ page: prev.page, loading: prev.loading, stalled: prev.stalled, timedOut: prev.timedOut, error: prev.error, tick: prev.tick + 1 }))
      }, [usable, source])

      React.useEffect(() => {
        if (usable === false) return undefined
        let live = true
        let timer
        // Throttled rather than debounced: the ledger must still move while a long answer
        // streams, and the last fragment of a burst has to land rather than being dropped.
        const onChange = () => {
          if (timer !== undefined) return
          timer = setTimeout(() => {
            timer = undefined
            if (live) push()
          }, LIVE_THROTTLE_MS)
        }
        if (typeof source.subscribe === 'function') source.subscribe(onChange)
        push()
        return () => {
          live = false
          if (timer !== undefined) clearTimeout(timer)
          if (typeof source.unsubscribe === 'function') source.unsubscribe(onChange)
        }
      }, [usable, source, push])

      // Pages are pulled one at a time, guarded by refs rather than by `state.loading`.
      //
      // The guard has to be synchronous and outside the render state. An earlier version kept
      // `state.loading` in this effect's dependencies and flipped it inside the effect; because
      // a ref advances only when a page RESOLVES, an effect re-entered mid-flight (the live
      // subscriber bumps `state.tick` whenever the window moves) started a second page request
      // for the same page number. Measured against a ledger that never ends: 399 `loadOlder`
      // calls against a cap of 200 — and it is invisible on a short history, which finishes
      // long before the doubling can show.
      React.useEffect(() => {
        if (usable === false || typeof source.loadOlder !== 'function') return undefined
        if (gaveUpRef.current === true) return undefined
        const before = windowOf(source.getSnapshot())
        // The largest window seen so far, remembered across retries. Comparing against the
        // effect's opening snapshot is not enough: when a retry does bring a page, the snapshot
        // has already grown by then, so `after > before` is satisfied by the PREVIOUS attempt's
        // page and the retry that actually produced it would be judged a no-op. (A test caught
        // exactly that.) A retry that sees anything new is progress, not a stall.
        if (before.entries.length > seenRef.current) seenRef.current = before.entries.length
        if (before.hasMore === false) {
          // Nothing to page. The initial state cannot know that — it is seeded with `usable` so
          // the first paint already says "reading" instead of showing an unfinished count — so
          // it is cleared here. Without this a session whose window is fully loaded would sit on
          // "正在读取更早的记录…" forever.
          setState((prev) => (prev.loading === true ? { page: prev.page, loading: false, tick: prev.tick } : prev))
          return undefined
        }
        if (inFlightRef.current === true) return undefined
        if (pageRef.current >= LOAD_OLDER_CAP) {
          gaveUpRef.current = true
          setState((prev) => (prev.stalled === true ? prev : { page: prev.page, loading: false, stalled: true, timedOut: false, tick: prev.tick }))
          return undefined
        }

        let live = true
        // The whole attempt sequence runs INSIDE this one effect, and only its CONCLUSION writes
        // state. An earlier revision wrote state after each attempt, so the effect re-ran between
        // attempts and the retry counter — being local — started over every time, which means the
        // limit could never be reached and the tab was back to retrying forever.
        let attempts = 0
        inFlightRef.current = true
        setState((prev) => (prev.loading === true ? prev : { page: prev.page, loading: true, tick: prev.tick }))

        const conclude = (patch) => {
          if (live === false || unmountedRef.current === true) return
          live = false
          if (watchdogRef.current !== undefined) {
            clearTimeout(watchdogRef.current)
            watchdogRef.current = undefined
          }
          inFlightRef.current = false
          setState((prev) => Object.assign({ page: prev.page, loading: false, stalled: false, timedOut: false, tick: prev.tick + 1 }, patch))
        }

        /** One page request, then judge it by what the WINDOW did — never by the promise alone. */
        const attemptPage = () => {
          if (live === false || unmountedRef.current === true) return
          attempts += 1
          watchdogRef.current = setTimeout(() => {
            watchdogRef.current = undefined
            // No answer at all: stop for good and say so.
            gaveUpRef.current = true
            conclude({ stalled: true, timedOut: true })
          }, LOAD_OLDER_TIMEOUT_MS)
          const judge = (kind, message) => {
            if (live === false || unmountedRef.current === true) return
            if (watchdogRef.current !== undefined) {
              clearTimeout(watchdogRef.current)
              watchdogRef.current = undefined
            }
            if (kind === 'error') {
              conclude({ error: message })
              return
            }
            const after = windowOf(source.getSnapshot())
            if (after.entries.length > seenRef.current) {
              // The window actually grew: that is a page read, whatever the promise said.
              seenRef.current = after.entries.length
              pageRef.current += 1
              conclude({ page: pageRef.current, error: null })
              return
            }
            // Settled, but nothing arrived. The real `loadOlder()` silently does nothing while
            // the session is still opening, so one no-op proves nothing; a run of them means the
            // history is not going to arrive and the tab must stop claiming it is reading it.
            if (attempts >= LOAD_OLDER_NO_PROGRESS_LIMIT) {
              gaveUpRef.current = true
              conclude({ stalled: true, timedOut: false })
              return
            }
            attemptPage()
          }
          let request
          try {
            request = source.loadOlder()
          } catch (error) {
            if (watchdogRef.current !== undefined) {
              clearTimeout(watchdogRef.current)
              watchdogRef.current = undefined
            }
            judge('error', '读取更早的记录失败：' + String(error && error.message ? error.message : error))
            return
          }
          // A host-side read is not guaranteed to answer with a promise, and `.then` on a
          // non-thenable throws inside an effect. `Promise.resolve` makes the shape irrelevant.
          Promise.resolve(request).then(
            () => judge('settled'),
            (error) => judge('error', '读取更早的记录失败：' + String(error === null || error === undefined ? '' : error)),
          )
        }
        attemptPage()

        // NOTE: no cleanup here, deliberately — see `watchdogRef`. This effect's job is to START a
        // paging attempt when none is running; ending one belongs to the attempt itself.
      }, [state.tick, usable, source])

      const ledger = React.useMemo(
        () => (usable ? ledgerFrom(seedRef.current, source.getSnapshot(), state) : buildLedger([], { hasMore: false, loading: false, error: absent })),
        [usable, source, state.tick, state.loading, state.page, state.error, state.stalled],
      )
      // A page that is merely `partial` is a real answer; one with no ledger at all is not, and
      // the difference is carried out to the view rather than inferred there. The two absent
      // cases stay distinct in the copy as well: "the service is missing" and "this session has
      // no ledger" are different problems, and a single message would misdirect whoever reads it.
      // `stalled` is carried out too, so the view can say "paging gave up" rather than "reading".
      return {
        ledger,
        loading: state.loading,
        page: state.page,
        stalled: state.stalled === true,
        timedOut: state.timedOut === true,
        error: state.error,
        usable,
        absent: usable ? null : absent,
      }
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
      '.sr-usage-when{opacity:.5;font-size:11px;margin-left:auto}',
      '.sr-usage-empty{opacity:.75}',
      '.sr-usage-note{margin-top:14px;opacity:.6;font-size:11px}',
      '.sr-usage-ver{position:sticky;bottom:0;margin-top:10px;padding-top:6px;opacity:.35;font-size:10px;font-family:var(--dsh-font-mono,ui-monospace,monospace);border-top:1px solid rgba(127,127,127,.12)}',
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

    /** The Chinese display name, then the English original — never one without the other. */
    function renderTitle(skill) {
      const zh = renderZh(skill)
      return zh === '' ? skill : zh + '  (' + skill + ')'
    }

    /**
     * What the header may claim.
     *
     * The window is the RECENT end of the history, so a count taken before paging finishes
     * undercounts — the whole reason `completeness` is threaded this far. A total is only
     * printed once `historyComplete` is true, and until then the tab says which page it is on
     * and whether older records still exist, rather than showing a number that would silently
     * be wrong.
     */
    function summaryOf(ledger) {
      const head = '本会话已加载 ' + ledger.files.length + ' 个技能名（' + ledger.calls + ' 次调用，涉及 ' + ledger.uniqueSkills + ' 个技能）'
      if (ledger.completeness === 'error') return head + '。'
      if (ledger.completeness === 'loading') return head + '，正在读取更早的记录…'
      if (ledger.completeness === 'partial') return head + '，更早的记录尚未读完。'
      return '本会话共 ' + ledger.calls + ' 次技能调用，涉及 ' + ledger.uniqueSkills + ' 个技能。'
    }

    function listOf(ledger) {
      const out = []
      for (let i = 0; i < ledger.files.length; i += 1) {
        const file = ledger.files[i]
        out.push(
          React.createElement(
            'div',
            { className: 'sr-usage-row', key: file.id },
            React.createElement('span', { className: 'sr-usage-idx' }, String(i + 1)),
            React.createElement('span', { className: 'sr-usage-zh' }, renderTitle(file.skill)),
            React.createElement('span', { className: 'sr-usage-en' }, file.tool),
            React.createElement('span', { className: 'sr-usage-when' }, file.turn === undefined || file.turn === null ? '' : '第 ' + file.turn + ' 轮'),
          ),
        )
      }
      return out
    }

    /** The footer's honesty about how much history was actually read. */
    function coverageOf(ledger, timedOut) {
      if (ledger.completeness === 'complete') return '已读到本会话最早一条记录，上面的数字是完整的。'
      if (ledger.completeness === 'error') return '读取更早记录时出错：' + ledger.error
      // `stalled` is spelled out rather than dressed up as "still reading": the difference between
      // "there is more and I am fetching it" and "there is more and I have stopped trying" is the
      // whole reason this line exists.
      if (ledger.completeness === 'loading') return '已读到第 ' + ledger.page + ' 页更早的记录，仍在继续。'
      // Three ways to stop, and they mean different things to whoever is debugging: the request
      // answered but moved nothing (the ledger's own read is a no-op right now), the request
      // never answered, or the paging cap was reached.
      if (timedOut === true) return '读取更早记录没有回应，已停止——上面的数字只是这部分的。'
      if (ledger.page === 0) return '账本暂时没有交出更早的记录（sessions.loadOlder 无进展），已停止——上面的数字只是这部分的。'
      return '已读到第 ' + ledger.page + ' 页更早的记录，之后不再继续读取——上面的数字只是这部分的。'
    }

    const NOTE = '中文名仅用于显示。技能名是 skill_load、索引检索和 /skill 命令的匹配键，实际调用的始终是英文原名；检索仍走英文原文，SKILL.md 未被修改。'

    /** The paging state as one machine-readable word, for the version line. */
    function coverageStateOf(ledger, timedOut) {
      if (ledger.completeness === 'complete') return '已读完'
      if (ledger.completeness === 'error') return '出错'
      if (ledger.completeness === 'loading') return '读取中'
      if (timedOut === true) return '超时停止'
      return ledger.page === 0 ? '无进展停止' : '到上限停止'
    }

    /**
     * Which build this is, printed in the tab.
     *
     * A browser bundle is served with `cache-control: public, max-age=31536000, immutable`, so
     * "did my change actually reach the page?" is a real question with no answer visible from the
     * outside — this file cannot be imported by a Node test and the served bytes sit behind the
     * Desktop renderer's capability check. Debugging exactly that over chat cost several rounds of
     * "still stuck", each of which was really "still the old build".
     *
     * So the version is stated in the UI. It MUST match package.json, and
     * `test/package-contract.mjs` asserts that it does — a label that can drift is worse than no
     * label at all.
     */
    const VERSION = '1.7.0'

    function UsageView(props) {
      const { ledger, usable, absent, timedOut } = useUsageLedger(props)

      // No ledger to read: say that, and say ONLY that. The summary and coverage lines below
      // are statements about data that was read, so printing them here would turn "I could not
      // read the history" into "I read the whole history and it was empty" — the one failure
      // mode this tab exists to avoid.
      if (usable === false) {
        return React.createElement(
          'div',
          { className: 'sr-usage' },
          React.createElement('h3', null, '技能调用清单'),
          React.createElement('p', { className: 'sr-usage-sum' }, absent === null ? '这个会话没有可用的技能记录。' : absent),
          React.createElement('p', { className: 'sr-usage-note' }, '技能调用记录来自会话账本 eventSource；读不到它时这里无法给出清单。'),
          React.createElement('p', { className: 'sr-usage-ver' }, 'dsh-skill-router v' + VERSION + ' · 账本不可用'),
        )
      }

      const head = ledger.error !== null && ledger.files.length === 0
        ? React.createElement('p', { className: 'sr-usage-sum' }, ledger.error)
        : React.createElement(
            'p',
            { className: 'sr-usage-sum' },
            ledger.files.length === 0 && ledger.completeness === 'complete' ? '本会话尚未加载任何技能。' : summaryOf(ledger),
          )

      return React.createElement(
        'div',
        { className: 'sr-usage' },
        React.createElement('h3', null, '技能调用清单'),
        head,
        ledger.files.length === 0 ? null : React.createElement('div', null, listOf(ledger)),
        React.createElement('p', { className: 'sr-usage-note' }, coverageOf(ledger, timedOut)),
        React.createElement('p', { className: 'sr-usage-note' }, NOTE),
        React.createElement(
          'p',
          { className: 'sr-usage-ver' },
          'dsh-skill-router v' + VERSION + ' · 第 ' + ledger.page + ' 页 · ' + coverageStateOf(ledger, timedOut),
        ),
      )
    }

    // Mounted per session. The tab is a singleton while sessions are not: React remounts the
    // inner view whenever the session changes (the key), so no session's seed, page count or
    // subscription can leak into another's rendering.
    function KeyedUsageView(props) {
      const input = props === null || props === undefined ? {} : props
      const sessionId = input.sessionId === null || input.sessionId === undefined ? '' : String(input.sessionId)
      return React.createElement(UsageView, {
        key: sessionId,
        source: input.source,
        sourceError: input.sourceError,
        sessionId: input.sessionId,
      })
    }

    /**
     * Bind this tab to one session's ledger.
     *
     * `inject` is how a `scope: "session"` slot hands a registration its session: the renderer
     * calls it with the scope binding's key and spreads the returned object over the
     * component's props. Every shipped tab in this row does the same — `trajectory` reaches its
     * session through `inject`, `chat` opens with `ctx.sessions.binding(sessionId)`. It is also
     * what makes the tab follow a session switch: the injected props are cached per session, so
     * the identity changes when the session does.
     *
     * Both arguments are accepted, and the order between them is deliberate. The slot catalog
     * for `conversation.view` exposes `sessionId: SessionId` as a standard prop, and the
     * renderer calls a registration's inject with the scope binding's KEY — while a second
     * argument is only threaded through the contextual-render path. So the first is the one to
     * trust and `binding.key` is the fallback.
     *
     * A missing or not-yet-resolvable session returns a message rather than throwing.
     * `binding()` answers `undefined` for a session that is neither listed nor already scoped,
     * and a throw here would take down the whole tab row instead of one tab in it.
     */
    function bindUsageSource(sessionId, binding) {
      const sessions = ctx.get('sessions')
      if (sessions === undefined) return { sourceError: '会话服务缺席（ctx.get("sessions") 为空）。' }
      const key = sessionId !== undefined && sessionId !== null ? sessionId : binding === null || binding === undefined ? undefined : binding.key
      const resolved = typeof sessions.binding === 'function' ? sessions.binding(key) : undefined
      const source = resolved === null || resolved === undefined ? undefined : resolved.eventSource
      if (source === null || source === undefined) return { sourceError: '这个会话的账本还不可用（sessions.binding 没有返回 eventSource）。' }
      return { source }
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
              inject: bindUsageSource,
            },
            KeyedUsageView,
          ),
        ),
      'skill-router: usage tab',
    )
  },
}

    return module.exports
  },
})
