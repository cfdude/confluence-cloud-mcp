export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Enumerate the whole of src/ so the coverage table reports files no test imports.
  // Without this jest only reports touched files and the global number flatters itself.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  // Floor, not a target. Set ~3 points below the numbers measured on 2026-08-25
  // (stmts 63.10 / branch 51.06 / funcs 60.85 / lines 62.17) so an honest refactor does
  // not trip it, but deleting tests or landing a sizeable untested module does.
  coverageThreshold: {
    global: {
      statements: 60,
      branches: 48,
      functions: 57,
      lines: 59,
    },
  },
};
