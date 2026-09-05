/**
 * Architectural guard rails.
 *
 * Lint catches bad code; this catches a bad *shape* — the import that quietly turns
 * two layers into one and is invisible in review because each file still looks fine.
 * Every rule below encodes a decision documented in the README.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle means the two modules are really one, and it breaks ESM initialisation order.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'A module nothing imports is either dead or a missing wire-up.',
      from: {
        orphan: true,
        pathNot: [
          '[.]d[.]ts$',
          '(^|/)[.][^/]+[.](js|cjs|mjs|ts|json)$',
          '[.](config|spec|test)[.](js|cjs|ts|tsx)$',
          '(^|/)(main|mcp-server|setup)[.](ts|tsx)$',
        ],
      },
      to: {},
    },
    {
      name: 'no-dev-dep-in-src',
      severity: 'error',
      comment: 'A devDependency in shipped code fails at runtime for the user, not for us.',
      from: {
        path: '^(backend|app|packages/[^/]+)/src',
        // Ambient declarations and test setup legitimately reference dev-only types.
        pathNot: ['[.](spec|test)[.](ts|tsx)$', '[.]d[.]ts$', '^app/src/test/'],
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      comment: 'Every runtime import must be declared, or it works here and nowhere else.',
      from: {},
      to: { dependencyTypes: ['unknown', 'undetermined', 'npm-no-pkg', 'npm-unknown'] },
    },

    // --- backend layering ---------------------------------------------------
    {
      name: 'shared-layers-stay-shared',
      severity: 'error',
      comment:
        'common/, config/ and security/ are imported by every feature; importing a ' +
        'feature back would make them un-reusable and create a cycle.',
      from: { path: '^backend/src/(common|config|security)/' },
      to: { path: '^backend/src/(chat|indexing|tools|vector|mcp|llm|events)/' },
    },
    {
      name: 'security-depends-on-nothing-local',
      severity: 'error',
      comment:
        'The access policy, the path allow-list and the credential deny-list are the ' +
        'whole threat model. They may read config, and nothing else in the app - a rule ' +
        'that stays reviewable only while its inputs stay this small.',
      from: { path: '^backend/src/security/' },
      to: { path: '^backend/src/(?!security/|config/)' },
    },
    {
      name: 'vector-is-a-leaf',
      severity: 'error',
      comment: 'The storage layer must not reach back up into the features that use it.',
      from: { path: '^backend/src/vector/' },
      to: { path: '^backend/src/(chat|indexing|tools|mcp|llm|events)/' },
    },
    {
      name: 'tools-do-not-depend-on-transport',
      severity: 'error',
      comment:
        'CodeToolsService is published over both HTTP and MCP; if it knew about either ' +
        'transport, the two surfaces could drift.',
      from: { path: '^backend/src/tools/' },
      to: { path: '^backend/src/(chat|mcp|events)/' },
    },
    {
      name: 'no-entry-point-imports',
      severity: 'error',
      comment: 'main.ts and mcp-server.ts are process entry points; nothing may import them.',
      from: { pathNot: '^backend/(src/(main|mcp-server)[.]ts)$' },
      to: { path: '^backend/src/(main|mcp-server)[.]ts$' },
    },

    // --- frontend layering --------------------------------------------------
    {
      name: 'store-stays-pure',
      severity: 'error',
      comment:
        'The Zustand store is synchronous state. Importing a component or the network ' +
        'layer would make it untestable and re-entrant.',
      from: { path: '^app/src/store/' },
      to: { path: '^app/src/(components|hooks|api)/' },
    },
    {
      name: 'api-layer-has-no-ui',
      severity: 'error',
      comment: 'The transport layer must not know what renders its results.',
      from: { path: '^app/src/api/' },
      to: { path: '^app/src/(components|store|hooks)/' },
    },
    {
      name: 'components-do-not-fetch',
      severity: 'warn',
      comment:
        'Components read the store and call props; hooks/useBackend owns I/O. ' +
        'Sidebar is the documented exception (removeRoot/cancelIndexing).',
      from: { path: '^app/src/components/', pathNot: '^app/src/components/Sidebar[.]tsx$' },
      to: { path: '^app/src/api/(http|socket)' },
    },

    // --- contracts ----------------------------------------------------------
    {
      name: 'contracts-depend-on-nothing',
      severity: 'error',
      comment:
        'The contracts package is imported by a Node service and a browser bundle. ' +
        'Anything beyond zod would break one of them.',
      from: { path: '^packages/contracts/src/' },
      to: {
        pathNot: ['^packages/contracts/src/', '^node_modules/zod/'],
        dependencyTypesNot: ['type-only'],
      },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage|reports|[.]stryker-tmp|src-tauri/target)(/|$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
      archi: {
        collapsePattern:
          '^(packages/[^/]+/src|app/src/[^/]+|backend/src/[^/]+|node_modules/(@[^/]+/[^/]+|[^/]+))',
      },
    },
  },
};
