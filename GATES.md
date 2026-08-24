# Gates: Admin productivity comparison

Scope: ship a protected, cache-backed Tokens vs productivity view with reliable GitHub and Linear synchronization, complete source-state reporting, and no regression to the existing limits portal.

- [x] G1: productivity synchronization and aggregation behavior passes its focused test suite
  CHECK: bun test tests/productivity.test.ts
  EXPECT: 0 fail
  CWD: apps/web
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/harlan/dev/omarchy-agents/apps/web; path=47e8e14b52f8/31 entries; output=20 expect() calls | Ran 5 tests across 1 file. [20.00ms]

- [x] G2: the admin authorization boundary and existing limits behavior remain covered and passing
  CHECK: bun test tests/auth-admin.test.ts tests/limits.test.ts
  EXPECT: 0 fail
  CWD: apps/web
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/harlan/dev/omarchy-agents/apps/web; path=47e8e14b52f8/31 entries; output=71 expect() calls | Ran 32 tests across 2 files. [114.00ms]

- [x] G3: the web application typechecks
  CHECK: bun run typecheck
  EXPECT: tsc --noEmit
  CWD: apps/web
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/harlan/dev/omarchy-agents/apps/web; path=47e8e14b52f8/31 entries; output=$ tsc --noEmit

- [x] G4: the web production bundle builds
  CHECK: bun run build
  EXPECT: vite build
  CWD: apps/web
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/harlan/dev/omarchy-agents/apps/web; path=47e8e14b52f8/31 entries; output=$ vite build

- [x] G5: the complete web test suite passes
  CHECK: bun test
  EXPECT: 0 fail
  CWD: apps/web
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/harlan/dev/omarchy-agents/apps/web; path=47e8e14b52f8/31 entries; output=148 expect() calls | Ran 67 tests across 9 files. [141.00ms]

- [x] G6: desktop and mobile review confirms the new view preserves the ruled Evidence Control Room language, remains operable, and labels ratios as descriptive and non-causal
  EVIDENCE: inspected apps/web/.impeccable/review/desktop-final.png and mobile-final.png; original finish reviewer re-scored all four material fixes resolved, found no regressions, and returned disposition: ship
