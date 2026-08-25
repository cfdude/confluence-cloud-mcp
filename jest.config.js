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
  // Floor, not a target. Set ~3 points below the numbers measured on 2026-08-25 after the
  // transport-and-client-coverage epic (stmts 83.07 / branch 69.82 / funcs 87.20 /
  // lines 83.67) so an honest refactor does not trip it, but deleting tests or landing a
  // sizeable untested module does.
  //
  // Previous floor, before that epic: 60 / 48 / 57 / 59, measured against
  // stmts 63.10 / branch 51.06 / funcs 60.85 / lines 62.17.
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 66,
      functions: 84,
      lines: 80,
    },
  },
};
